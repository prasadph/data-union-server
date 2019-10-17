const {
    Contract,
    getDefaultProvider,
    providers: { JsonRpcProvider }
} = require("ethers")

const StreamrClient = require("streamr-client")

const { throwIfNotContract } = require("../src/utils/checkArguments")

const TokenJson = require("../build/ERC20Detailed.json")
const CommunityJson = require("../build/CommunityProduct.json")

const {
    ETHEREUM_SERVER,            // explicitly specify server address
    ETHEREUM_NETWORK,           // use ethers.js default servers

    COMMUNITY_ADDRESS,

    STREAMR_WS_URL,
    STREAMR_HTTP_URL,

    QUIET,
} = process.env

const log = QUIET ? () => {} : (...args) => {
    console.log(...args)
}
const error = (e, ...args) => {
    console.error(e.stack, ...args)
    process.exit(1)
}

async function start() {
    const provider =
        ETHEREUM_SERVER ? new JsonRpcProvider(ETHEREUM_SERVER) :
        ETHEREUM_NETWORK ? getDefaultProvider(ETHEREUM_NETWORK) : null
    if (!provider) { throw new Error("Must supply either ETHEREUM_SERVER or ETHEREUM_NETWORK") }
    try {
        const url = provider.connection ? provider.connection.url : provider.providers[0].connection.url
        log(`Connecting to ${url}`)
    } catch (e) { /*ignore*/ }
    const network = await provider.getNetwork()
    log(`Network is ${JSON.stringify(network)}`)

    const communityAddress = await throwIfNotContract(provider, COMMUNITY_ADDRESS, "env variable COMMUNITY_ADDRESS")

    log(`Checking community contract at ${communityAddress}...`)
    const community = new Contract(communityAddress, CommunityJson.abi, provider)
    const getters = CommunityJson.abi.filter(f => f.constant && f.inputs.length === 0).map(f => f.name)
    for (const getter of getters) {
        log(`  ${getter}: ${await community[getter]()}`)
    }

    const _tokenAddress = await community.token()
    const tokenAddress = await throwIfNotContract(provider, _tokenAddress, `community(${communityAddress}).token`)

    log(`Checking token contract at ${tokenAddress}...`)
    const token = new Contract(tokenAddress, TokenJson.abi, provider)
    log("  Token name: ", await token.name())
    log("  Token symbol: ", await token.symbol())
    log("  Token decimals: ", await token.decimals())

    log("Connecting to Streamr...")
    const opts = {}
    if (STREAMR_WS_URL) { opts.url = STREAMR_WS_URL }
    if (STREAMR_HTTP_URL) { opts.restUrl = STREAMR_HTTP_URL }
    const client = new StreamrClient(opts)

    log("Listing all members...")
    // TODO: use client once withdraw is available from NPM
    //const memberList = await client.getMembers(communityAddress)
    const memberList = await getMembers(communityAddress)
    for (const {address, earnings} of memberList) {
        log(`  ${address}`)
        log(`    Server: Total earnings: ${earnings}`)
        log(`    Contract: Withdrawn earnings: ${(await community.withdrawn(address)).toString()}`)
    }
}

start().catch(error)

const fetch = require("node-fetch")
async function getMembers(communityAddress) {
    const url = `${STREAMR_HTTP_URL || "https://streamr.com/api/v1"}/communities/${communityAddress}/members`
    return fetch(url).then((res) => res.json())
}
