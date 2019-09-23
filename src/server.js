const {
    Contract,
    utils: { id, getAddress, hexZeroPad, Interface }
} = require("ethers")

const FileStore = require("monoplasma/src/fileStore")

const MonoplasmaOperator = require("./operator")
const StreamrChannel = require("./streamrChannel")

const CommunityProductJson = require("../build/CommunityProduct.json")

const { throwIfNotSet } = require("./utils/checkArguments")

const operatorChangedEventTopic = id("OperatorChanged(address)")
const operatorChangedAbi = ["event OperatorChanged(address indexed newOperator)"]
const operatorChangedInterface = new Interface(operatorChangedAbi)

/**
 * @typedef {string} EthereumAddress is hex string /0x[0-9A-Fa-f]^64/, return value from ethers.utils.getAddress
 */

/**
 * @property {Map<EthereumAddress, Community>} communities
 */
module.exports = class CommunityProductServer {
    /**
     *
     * @param {Wallet} wallet from ethers.js
     */
    constructor(wallet, storeDir, operatorConfig, log, error) {
        throwIfNotSet(wallet, "Wallet argument to new CommunityProductServer")
        throwIfNotSet(storeDir, "Store directory argument to new CommunityProductServer")

        this.wallet = wallet
        this.eth = wallet.provider
        this.log = log || console.log
        this.error = error || console.error
        this.communities = {}       // mapping: Ethereum address => Community object
        this.storeDir = storeDir
        this.operatorConfig = operatorConfig || {}
        this.communityIsRunningPromises = {}
        //this.whitelist = whitelist    // TODO
        //this.blacklist = blacklist
    }

    async start() {
        await this.playbackPastOperatorChangedEvents()

        this.eth.on({ topics: [operatorChangedEventTopic] }, log => {
            let event = operatorChangedInterface.parseLog(log)
            this.log("Seen OperatorChanged event: " + JSON.stringify(event))
            const contractAddress = getAddress(log.address)
            this.onOperatorChangedEventAt(contractAddress).catch(err => {
                this.error(err.stack)
            })
        })
    }

    async stop() {
        this.eth.removeAllListeners({ topics: [operatorChangedEventTopic] })
        // TODO: hand over operators to another server?
    }

    async playbackPastOperatorChangedEvents() {
        //playback events of OperatorChanged(this wallet)
        const filter = {
            fromBlock: 1,
            toBlock: "latest",
            topics: [operatorChangedEventTopic, hexZeroPad(this.wallet.address, 32).toLowerCase()]
        }

        const logs = await this.eth.getLogs(filter)

        // TODO: we should also catch all OperatorChanged from communities that we we've operated
        //    so that we can detect if we've been swapped out

        for (let log of logs) {
            let event = operatorChangedInterface.parseLog(log)
            this.log("Playing back past OperatorChanged event: " + JSON.stringify(event))
            const contractAddress = getAddress(log.address)
            await this.onOperatorChangedEventAt(contractAddress).catch(err => {
                // TODO: while developing, 404 for joinPartStream could just mean
                //   mysql has been emptied by streamr-ganache docker not,
                //   so some old joinPartStreams are in ganache but not in mysql
                //   Solution is to `streamr-docker-dev restart ganache`
                // For production on the other hand... 404 could be bad.
                //   Streamr might have lost joinPartStreams, and they should be re-created from
                //   the last valid monoplasma members lists if such are available (IPFS sharing anyone?)
                this.error(err.stack)

                // at any rate, we should not just catch it and keep chugging
                throw err
            })
        }
    }

    /**
     * Filter how to respond to OperatorChanged events, pass new communities to startOperating
     * TODO: abuse defenses could be replaced with bytecode checking or similar if feasible
     * @param {string} address
     */
    async onOperatorChangedEventAt(address) {
        const contract = new Contract(address, CommunityProductJson.abi, this.eth)
        const newOperatorAddress = getAddress(await contract.operator())
        const weShouldOperate = newOperatorAddress === this.wallet.address
        const community = this.communities[address]
        if (!community) {
            if (weShouldOperate) {
                // rapid event spam stopper (from one contract)
                this.communities[address] = {
                    state: "launching",
                    eventDetectedAt: Date.now(),
                }

                this.communityIsRunning(address) // create the promise to prevent later creation
                try {
                    const result = await this.startOperating(address)
                    this.communityIsRunningPromises[address].setRunning(result)
                } catch (err) {
                    this.communityIsRunningPromises[address].setFailed(err)
                }
            } else {
                this.log(`Detected a community for operator ${newOperatorAddress}, ignoring.`)
            }
        } else {
            if (!community.operator || !community.operator.contract) {
                // abuse mitigation: only serve one community per event.address
                //   normally CommunityProduct shouldn't send several requests (potential spam attack attempt)
                this.error(`Too rapid OperatorChanged events from ${address}, community is still launching`)
                return
            }
            if (weShouldOperate) {
                this.log(`Repeated OperatorChanged("${newOperatorAddress}") event from ${address}`)
                return
            }

            // operator was changed, we can stop running the operator process
            await community.operator.shutdown()
            delete this.communities[address]
        }
    }

    /**
     * Helper function to await community deployments (after smart contract sent)
     * @param {EthereumAddress} address of the community to watch
     * @returns {Promise} that resolves when community is successfully started, or fails if starting fails
     */
    async communityIsRunning(address) {
        if (!(address in this.communityIsRunningPromises)) {
            let setRunning, setFailed
            const promise = new Promise((done, fail) => {
                setRunning = done
                setFailed = fail
            })
            this.communityIsRunningPromises[address] = {
                promise, setRunning, setFailed
            }
        }
        return this.communityIsRunningPromises[address].promise
    }

    /**
     * Create a join/part channel for the community when operator is being created
     * Separated from startOperating to be better able to inject mocks in testing
     * @param {EthereumAddress} communityAddress of the community to be operated
     */
    async getChannelFor(communityAddress) {
        const address = getAddress(communityAddress)
        const contract = new Contract(address, CommunityProductJson.abi, this.eth)

        // check if joinPartStream is valid (TODO: move to Channel?)
        const joinPartStreamId = await contract.joinPartStream()
        const channel = new StreamrChannel(this.wallet.privateKey, joinPartStreamId, this.operatorConfig.streamrWsUrl, this.operatorConfig.streamrHttpUrl)
        await channel.client.getStream(joinPartStreamId).catch(e => { throw new Error(`joinPartStream ${joinPartStreamId} in CommunityProduct contract at ${communityAddress} is not found in Streamr (error: ${e.stack.toString()})`) })

        return channel
    }

    /**
     * Create a state and block store for the community when operator is being created
     * Separated from startOperating to be better able to inject mocks in testing
     * @param {EthereumAddress} communityAddress of the community to be operated
     */
    async getStoreFor(communityAddress) {
        const address = getAddress(communityAddress)
        const storeDir = `${this.storeDir}/${address}`
        this.log(`Storing community ${communityAddress} data at ${storeDir}`)
        const fileStore = new FileStore(storeDir)
        return fileStore
    }

    async startOperating(communityAddress) {
        const address = getAddress(communityAddress)
        const contract = new Contract(address, CommunityProductJson.abi, this.eth)

        const operatorAddress = getAddress(await contract.operator())
        if (operatorAddress !== this.wallet.address) {
            throw new Error(`startOperating: Community requesting operator ${operatorAddress}, not a job for me (${this.wallet.address})`)
        }

        const operatorChannel = await this.getChannelFor(address)
        const operatorStore = await this.getStoreFor(address)
        const log = (...args) => { this.log(`${address}> `, ...args) }
        const error = (e, ...args) => { this.error(e, `\n${address}> `, ...args) }
        const config = Object.assign({}, this.operatorConfig, { contractAddress: address })
        const operator = new MonoplasmaOperator(this.wallet, operatorChannel, operatorStore, log, error)
        await operator.start(config)

        const community = {
            state: "running",
            address,
            operator,
            joinPartStreamId: operatorChannel.stream.id,
        }
        this.communities[address] = community
        return community
    }
}
