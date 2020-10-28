import {
    AmongusServer,
    MasterServers,
    MapID,
    DisconnectID
} from "../index.js"

const client = new AmongusServer({
    debug: false,
    logs: true
});

await client.listen(22023);

client.on("identify", remote => {

});