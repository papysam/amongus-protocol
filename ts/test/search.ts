import {
    AmongusClient,
    MasterServers,
    MapID
} from "../index.js"

const client = new AmongusClient({
    debug: true
});

await client.connect("127.0.0.1", 22023, "weakeyes");

const games = await client.search([MapID.TheSkeld]);

console.log(games);