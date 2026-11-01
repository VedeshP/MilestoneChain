// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title  MilestoneEscrow
 * @notice Trustless milestone-based escrow with verifiable software deliverables.
 *         ETH is only released after the client cryptographically confirms
 *         the artifact they received matches the hash registered by the developer.
 *
 *  Economic model
 *  ──────────────
 *  • Platform fee   0.5% of every milestone payout (approval or dispute ruling)
 *  • Dispute stake  5%   of the milestone — posted by BOTH sides ("loser pays")
 *      - disputer posts it in raiseDispute()
 *      - the other party posts it in respondToDispute() to contest
 *      - if they don't respond within responseWindow, disputer wins by default
 *  • Arbitrator fee 1%   of the milestone — paid out of the LOSER's slashed stake
 *  • Slashed stake remainder (5% − 1% = 4%) → platform
 *  • Winner's stake is returned in full
 *
 * @dev BCT Final Lab Project — MilestoneChain
 */
contract MilestoneEscrow {

    // ─── Enums ────────────────────────────────────────────────────────────
    enum ProjectStatus   { Active, Completed, Disputed, Cancelled }
    enum MilestoneStatus { Pending, Submitted, Verified, Approved, Disputed, Refunded }
    enum ArtifactType    { BuildOutput, ZipArchive, CommitHash, DockerImage, Other }

    // ─── Structs ──────────────────────────────────────────────────────────
    struct Milestone {
        string          description;
        uint256         amount;
        bytes32         artifactHash;   // SHA-256 submitted by developer
        string          artifactName;   // human-readable artifact identifier
        ArtifactType    artifactType;
        bool            isVerified;     // set to true by verifyDeliverable()
        bytes32         clientHash;     // last hash the client checked (evidence for arbitrator)
        MilestoneStatus status;
        uint256         submittedAt;
    }

    struct Project {
        uint256         id;
        string          name;
        string          description;
        address payable client;
        address payable developer;
        address payable arbitrator;
        uint256         totalAmount;
        uint256         releasedAmount;   // gross amount settled to developer (incl. fees)
        uint256         refundedAmount;   // gross amount returned to client  (incl. fees)
        uint256         milestoneCount;
        uint256         settledCount;     // approved + refunded milestones
        ProjectStatus   status;
        uint256         createdAt;
    }

    struct Dispute {
        uint256         milestoneIndex;
        address payable disputer;
        address payable respondent;
        uint256         stake;            // stake per side
        bool            responded;        // respondent posted counter-stake
        uint256         deadline;         // respondent must respond before this
        string          reason;
        bool            open;
    }

    // ─── Constants (basis points, 10 000 = 100%) ──────────────────────────
    uint256 public constant BPS               = 10_000;
    uint256 public constant PLATFORM_FEE_BPS  = 50;    // 0.5%
    uint256 public constant ARBITRATOR_FEE_BPS = 100;  // 1%
    uint256 public constant STAKE_BPS         = 500;   // 5%

    // ─── State Variables ──────────────────────────────────────────────────
    address public owner;
    uint256 public projectCount;
    uint256 public platformBalance;      // accumulated, withdrawable by owner
    uint256 public responseWindow;       // seconds the respondent has to counter-stake

    mapping(uint256 => Project)                       public projects;
    mapping(uint256 => mapping(uint256 => Milestone)) public milestones;
    mapping(uint256 => Dispute)                       public disputes;   // one open dispute per project

    bool private locked;

    // ─── Events ───────────────────────────────────────────────────────────
    event ProjectCreated(uint256 indexed id, string name, address indexed client, address indexed developer, uint256 totalAmount);
    event MilestoneSubmitted(uint256 indexed projectId, uint256 milestoneIndex, bytes32 artifactHash, string artifactName, ArtifactType artifactType);
    event DeliverableVerified(uint256 indexed projectId, uint256 milestoneIndex, bool hashMatched);
    event MilestoneApproved(uint256 indexed projectId, uint256 milestoneIndex, uint256 developerAmount, uint256 platformFee);
    event DisputeRaised(uint256 indexed projectId, uint256 milestoneIndex, address raisedBy, uint256 stake, string reason);
    event DisputeResponded(uint256 indexed projectId, uint256 milestoneIndex, address respondent, uint256 stake);
    event DisputeResolved(uint256 indexed projectId, uint256 milestoneIndex, bool favorDeveloper, address winner, uint256 slashed, uint256 arbitratorFee, uint256 platformFee);
    event ProjectCompleted(uint256 indexed projectId);
    event ClientRefunded(uint256 indexed projectId, uint256 amount);
    event PlatformWithdrawn(address indexed to, uint256 amount);

    // ─── Modifiers ────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "MilestoneChain: Not the owner");
        _;
    }

    modifier onlyClient(uint256 _id) {
        require(msg.sender == projects[_id].client,     "MilestoneChain: Not the client");
        _;
    }

    modifier onlyDeveloper(uint256 _id) {
        require(msg.sender == projects[_id].developer,  "MilestoneChain: Not the developer");
        _;
    }

    modifier onlyArbitrator(uint256 _id) {
        require(msg.sender == projects[_id].arbitrator, "MilestoneChain: Not the arbitrator");
        _;
    }

    modifier projectExists(uint256 _id) {
        require(_id > 0 && _id <= projectCount,         "MilestoneChain: Project does not exist");
        _;
    }

    modifier projectActive(uint256 _id) {
        require(projects[_id].status == ProjectStatus.Active, "MilestoneChain: Project not active");
        _;
    }

    modifier validMilestone(uint256 _id, uint256 _idx) {
        require(_idx < projects[_id].milestoneCount,    "MilestoneChain: Invalid milestone index");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "MilestoneChain: Reentrant call");
        locked = true;
        _;
        locked = false;
    }

    // ─── Constructor ──────────────────────────────────────────────────────
    /**
     * @param _responseWindow Seconds a respondent has to counter-stake a dispute
     *                        (use a few minutes for demos, days in production).
     */
    constructor(uint256 _responseWindow) {
        require(_responseWindow > 0, "MilestoneChain: Window must be > 0");
        owner = msg.sender;
        responseWindow = _responseWindow;
    }

    // ─── Fee helpers ──────────────────────────────────────────────────────
    function platformFeeOf(uint256 _amount)   public pure returns (uint256) { return _amount * PLATFORM_FEE_BPS   / BPS; }
    function arbitratorFeeOf(uint256 _amount) public pure returns (uint256) { return _amount * ARBITRATOR_FEE_BPS / BPS; }
    function stakeOf(uint256 _amount)         public pure returns (uint256) { return _amount * STAKE_BPS          / BPS; }

    function requiredStake(uint256 _projectId, uint256 _milestoneIndex) external view returns (uint256) {
        return stakeOf(milestones[_projectId][_milestoneIndex].amount);
    }

    // ─── 1. Create project ────────────────────────────────────────────────
    /**
     * @notice Client creates a project and locks ETH into the contract.
     * @dev    msg.value MUST equal the exact sum of _milestoneAmounts.
     */
    function createProject(
        string   memory   _name,
        string   memory   _description,
        address  payable  _developer,
        address  payable  _arbitrator,
        string[] memory   _milestoneDescs,
        uint256[] memory  _milestoneAmounts
    ) external payable returns (uint256) {
        require(bytes(_name).length > 0,                            "MilestoneChain: Name is empty");
        require(_developer != address(0),                           "MilestoneChain: Invalid developer address");
        require(_developer != msg.sender,                           "MilestoneChain: Client cannot be developer");
        require(_arbitrator != address(0),                          "MilestoneChain: Invalid arbitrator address");
        require(_arbitrator != msg.sender && _arbitrator != _developer, "MilestoneChain: Arbitrator must be neutral");
        require(_milestoneDescs.length > 0,                         "MilestoneChain: No milestones provided");
        require(_milestoneDescs.length == _milestoneAmounts.length, "MilestoneChain: Arrays length mismatch");

        uint256 total = 0;
        for (uint256 i = 0; i < _milestoneAmounts.length; i++) {
            require(_milestoneAmounts[i] > 0, "MilestoneChain: Milestone amount must be > 0");
            total += _milestoneAmounts[i];
        }
        require(msg.value == total, "MilestoneChain: ETH sent must equal total of milestone amounts");

        projectCount++;
        Project storage p = projects[projectCount];
        p.id             = projectCount;
        p.name           = _name;
        p.description    = _description;
        p.client         = payable(msg.sender);
        p.developer      = _developer;
        p.arbitrator     = _arbitrator;
        p.totalAmount    = msg.value;
        p.milestoneCount = _milestoneDescs.length;
        p.status         = ProjectStatus.Active;
        p.createdAt      = block.timestamp;

        for (uint256 i = 0; i < _milestoneDescs.length; i++) {
            Milestone storage m = milestones[projectCount][i];
            m.description  = _milestoneDescs[i];
            m.amount       = _milestoneAmounts[i];
            m.artifactType = ArtifactType.Other;
            m.status       = MilestoneStatus.Pending;
        }

        emit ProjectCreated(projectCount, _name, msg.sender, _developer, msg.value);
        return projectCount;
    }

    // ─── 2. Developer submits artifact hash ───────────────────────────────
    function submitMilestone(
        uint256       _projectId,
        uint256       _milestoneIndex,
        bytes32       _artifactHash,
        string memory _artifactName,
        ArtifactType  _artifactType
    )
        external
        projectExists(_projectId)
        projectActive(_projectId)
        onlyDeveloper(_projectId)
        validMilestone(_projectId, _milestoneIndex)
    {
        require(_artifactHash != bytes32(0),     "MilestoneChain: Artifact hash cannot be zero");
        require(bytes(_artifactName).length > 0, "MilestoneChain: Artifact name cannot be empty");

        Milestone storage m = milestones[_projectId][_milestoneIndex];
        require(m.status == MilestoneStatus.Pending, "MilestoneChain: Milestone already submitted or settled");

        m.artifactHash = _artifactHash;
        m.artifactName = _artifactName;
        m.artifactType = _artifactType;
        m.status       = MilestoneStatus.Submitted;
        m.submittedAt  = block.timestamp;

        emit MilestoneSubmitted(_projectId, _milestoneIndex, _artifactHash, _artifactName, _artifactType);
    }

    // ─── 3. Client verifies the deliverable (THE KEY FUNCTION) ────────────
    /**
     * @notice Client submits the hash of the file they received. If it matches the
     *         developer's registered hash, the milestone becomes Verified.
     *         On mismatch the client's hash is stored as evidence for a dispute.
     */
    function verifyDeliverable(
        uint256 _projectId,
        uint256 _milestoneIndex,
        bytes32 _clientComputedHash
    )
        external
        projectExists(_projectId)
        projectActive(_projectId)
        onlyClient(_projectId)
        validMilestone(_projectId, _milestoneIndex)
        returns (bool matched)
    {
        require(_clientComputedHash != bytes32(0), "MilestoneChain: Hash cannot be zero");

        Milestone storage m = milestones[_projectId][_milestoneIndex];
        require(m.status == MilestoneStatus.Submitted, "MilestoneChain: Milestone not yet submitted by developer");

        m.clientHash = _clientComputedHash;
        matched = (m.artifactHash == _clientComputedHash);
        if (matched) {
            m.isVerified = true;
            m.status     = MilestoneStatus.Verified;
        }

        emit DeliverableVerified(_projectId, _milestoneIndex, matched);
    }

    // ─── 4. Client approves → developer paid (minus 0.5% platform fee) ────
    function approveMilestone(uint256 _projectId, uint256 _milestoneIndex)
        external
        nonReentrant
        projectExists(_projectId)
        projectActive(_projectId)
        onlyClient(_projectId)
        validMilestone(_projectId, _milestoneIndex)
    {
        Milestone storage m = milestones[_projectId][_milestoneIndex];
        require(m.status == MilestoneStatus.Verified && m.isVerified,
            "MilestoneChain: Deliverable not verified yet - call verifyDeliverable first");

        Project storage p = projects[_projectId];
        m.status = MilestoneStatus.Approved;
        p.releasedAmount += m.amount;

        uint256 fee = platformFeeOf(m.amount);
        uint256 net = m.amount - fee;
        platformBalance += fee;
        _settle(_projectId);

        _send(p.developer, net);
        emit MilestoneApproved(_projectId, _milestoneIndex, net, fee);
    }

    // ─── 5. Raise dispute (stake 5%) ──────────────────────────────────────
    /**
     * @notice Client or developer disputes a Submitted milestone by staking 5%.
     *         Typical case: client's verifyDeliverable() returned a hash mismatch.
     *         Developer may dispute if the client refuses to verify a genuine artifact.
     */
    function raiseDispute(uint256 _projectId, uint256 _milestoneIndex, string memory _reason)
        external
        payable
        projectExists(_projectId)
        projectActive(_projectId)
        validMilestone(_projectId, _milestoneIndex)
    {
        Project storage p = projects[_projectId];
        require(msg.sender == p.client || msg.sender == p.developer,
            "MilestoneChain: Only client or developer can raise a dispute");
        require(bytes(_reason).length > 0, "MilestoneChain: Reason cannot be empty");

        Milestone storage m = milestones[_projectId][_milestoneIndex];
        require(m.status == MilestoneStatus.Submitted, "MilestoneChain: Only a submitted, unverified milestone can be disputed");

        uint256 stake = stakeOf(m.amount);
        require(msg.value == stake, "MilestoneChain: Must stake exactly 5% of milestone amount");

        address payable respondent = msg.sender == p.client ? p.developer : p.client;

        m.status = MilestoneStatus.Disputed;
        p.status = ProjectStatus.Disputed;
        disputes[_projectId] = Dispute({
            milestoneIndex: _milestoneIndex,
            disputer:       payable(msg.sender),
            respondent:     respondent,
            stake:          stake,
            responded:      false,
            deadline:       block.timestamp + responseWindow,
            reason:         _reason,
            open:           true
        });

        emit DisputeRaised(_projectId, _milestoneIndex, msg.sender, stake, _reason);
    }

    // ─── 6. Respondent counter-stakes to contest ──────────────────────────
    function respondToDispute(uint256 _projectId) external payable projectExists(_projectId) {
        Dispute storage d = disputes[_projectId];
        require(d.open,                          "MilestoneChain: No open dispute");
        require(msg.sender == d.respondent,      "MilestoneChain: Not the respondent");
        require(!d.responded,                    "MilestoneChain: Already responded");
        require(block.timestamp <= d.deadline,   "MilestoneChain: Response window closed");
        require(msg.value == d.stake,            "MilestoneChain: Must match the disputer's stake");

        d.responded = true;
        emit DisputeResponded(_projectId, d.milestoneIndex, msg.sender, msg.value);
    }

    // ─── 7. Arbitrator rules — loser's stake is slashed ───────────────────
    /**
     * @param _favorDeveloper true → developer gets the milestone | false → client refunded
     */
    function resolveDispute(uint256 _projectId, bool _favorDeveloper)
        external
        nonReentrant
        projectExists(_projectId)
        onlyArbitrator(_projectId)
    {
        Dispute storage d = disputes[_projectId];
        require(d.open,      "MilestoneChain: No open dispute");
        require(d.responded, "MilestoneChain: Respondent has not staked yet - wait or claim default");

        Project storage p = projects[_projectId];
        address payable winner = _favorDeveloper ? p.developer : p.client;
        Milestone storage m = milestones[_projectId][d.milestoneIndex];

        // Loser's stake: 1% of milestone to arbitrator, remainder to platform
        uint256 slashed  = d.stake;
        uint256 arbFee   = arbitratorFeeOf(m.amount);
        if (arbFee > slashed) arbFee = slashed;
        platformBalance += slashed - arbFee;

        uint256 milestoneFee = _closeDispute(_projectId, _favorDeveloper);

        _send(winner, d.stake);              // winner's own stake back
        _send(p.arbitrator, arbFee);

        emit DisputeResolved(_projectId, d.milestoneIndex, _favorDeveloper, winner, slashed, arbFee, milestoneFee);
    }

    // ─── 8. Default win if respondent never counter-staked ────────────────
    function claimDefault(uint256 _projectId) external nonReentrant projectExists(_projectId) {
        Dispute storage d = disputes[_projectId];
        require(d.open,                        "MilestoneChain: No open dispute");
        require(msg.sender == d.disputer,      "MilestoneChain: Only the disputer can claim");
        require(!d.responded,                  "MilestoneChain: Respondent contested - arbitrator must decide");
        require(block.timestamp > d.deadline,  "MilestoneChain: Response window still open");

        bool favorDeveloper = d.disputer == projects[_projectId].developer;
        uint256 milestoneFee = _closeDispute(_projectId, favorDeveloper);

        _send(d.disputer, d.stake);          // stake back — nobody was slashed, arbitrator not involved
        emit DisputeResolved(_projectId, d.milestoneIndex, favorDeveloper, d.disputer, 0, 0, milestoneFee);
    }

    // ─── 9. Client cancels — unused funds back (no fee) ───────────────────
    function refundClient(uint256 _projectId)
        external
        nonReentrant
        projectExists(_projectId)
        projectActive(_projectId)
        onlyClient(_projectId)
    {
        Project storage p = projects[_projectId];
        uint256 remaining = 0;
        for (uint256 i = 0; i < p.milestoneCount; i++) {
            Milestone storage m = milestones[_projectId][i];
            require(m.status != MilestoneStatus.Submitted && m.status != MilestoneStatus.Verified,
                "MilestoneChain: Cannot cancel - a milestone is awaiting review");
            if (m.status == MilestoneStatus.Pending) {
                m.status   = MilestoneStatus.Refunded;
                remaining += m.amount;
            }
        }
        require(remaining > 0, "MilestoneChain: No ETH left to refund");

        p.refundedAmount += remaining;
        p.status = ProjectStatus.Cancelled;

        _send(p.client, remaining);
        emit ClientRefunded(_projectId, remaining);
    }

    // ─── 10. Owner withdraws accumulated platform fees ────────────────────
    function withdrawPlatformFees() external nonReentrant onlyOwner {
        uint256 amount = platformBalance;
        require(amount > 0, "MilestoneChain: Nothing to withdraw");
        platformBalance = 0;
        _send(payable(owner), amount);
        emit PlatformWithdrawn(owner, amount);
    }

    // ─── Internal ─────────────────────────────────────────────────────────
    /// @dev Pays the milestone (minus 0.5% fee) to the winning side and reopens the project.
    function _closeDispute(uint256 _projectId, bool _favorDeveloper) internal returns (uint256 fee) {
        Dispute storage d = disputes[_projectId];
        Project storage p = projects[_projectId];
        Milestone storage m = milestones[_projectId][d.milestoneIndex];

        d.open   = false;
        p.status = ProjectStatus.Active;

        fee = platformFeeOf(m.amount);
        platformBalance += fee;
        uint256 net = m.amount - fee;

        if (_favorDeveloper) {
            m.status     = MilestoneStatus.Approved;
            m.isVerified = true;
            p.releasedAmount += m.amount;
            _settle(_projectId);
            _send(p.developer, net);
        } else {
            m.status = MilestoneStatus.Refunded;
            p.refundedAmount += m.amount;
            _settle(_projectId);
            _send(p.client, net);
        }
    }

    function _settle(uint256 _projectId) internal {
        Project storage p = projects[_projectId];
        p.settledCount += 1;
        if (p.settledCount == p.milestoneCount) {
            p.status = ProjectStatus.Completed;
            emit ProjectCompleted(_projectId);
        }
    }

    function _send(address payable _to, uint256 _amount) internal {
        if (_amount == 0) return;
        (bool ok, ) = _to.call{value: _amount}("");
        require(ok, "MilestoneChain: ETH transfer failed");
    }

    // ─── View Functions ───────────────────────────────────────────────────
    function getProject(uint256 _projectId)
        external view projectExists(_projectId)
        returns (
            uint256 id, string memory name, string memory description,
            address client, address developer, address arbitrator,
            uint256 totalAmount, uint256 releasedAmount, uint256 refundedAmount,
            uint256 milestoneCount, uint256 settledCount,
            ProjectStatus status, uint256 createdAt
        )
    {
        Project storage p = projects[_projectId];
        return (p.id, p.name, p.description, p.client, p.developer, p.arbitrator,
                p.totalAmount, p.releasedAmount, p.refundedAmount,
                p.milestoneCount, p.settledCount, p.status, p.createdAt);
    }

    function getMilestone(uint256 _projectId, uint256 _milestoneIndex)
        external view projectExists(_projectId) validMilestone(_projectId, _milestoneIndex)
        returns (
            string memory description, uint256 amount,
            bytes32 artifactHash, string memory artifactName,
            ArtifactType artifactType, bool isVerified, bytes32 clientHash,
            MilestoneStatus status, uint256 submittedAt
        )
    {
        Milestone storage m = milestones[_projectId][_milestoneIndex];
        return (m.description, m.amount, m.artifactHash, m.artifactName,
                m.artifactType, m.isVerified, m.clientHash, m.status, m.submittedAt);
    }

    function getDispute(uint256 _projectId)
        external view projectExists(_projectId)
        returns (
            uint256 milestoneIndex, address disputer, address respondent, uint256 stake,
            bool responded, uint256 deadline, string memory reason, bool open
        )
    {
        Dispute storage d = disputes[_projectId];
        return (d.milestoneIndex, d.disputer, d.respondent, d.stake,
                d.responded, d.deadline, d.reason, d.open);
    }

    function getProjectCount() external view returns (uint256) { return projectCount; }

    function getRemainingBalance(uint256 _projectId) external view projectExists(_projectId) returns (uint256) {
        Project storage p = projects[_projectId];
        return p.totalAmount - p.releasedAmount - p.refundedAmount;
    }
}
