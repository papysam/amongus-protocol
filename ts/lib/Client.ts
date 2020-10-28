import { ClientOptions } from "./interfaces/ClientOptions.js"
import { BufferReader } from "./util/BufferReader.js"

import { parsePacket } from "./Parser.js"
import { composePacket } from "./Compose.js"

import dgram from "dgram"
import util from "util"
import { EventEmitter } from "events"
import { GameListGame, Packet, BasePayload, PayloadPacket, PlayerVoteAreaFlags, Payload, GameOptionsData } from "./interfaces/Packets.js"
import { DisconnectID, DistanceID, LanguageID, MapID, MessageID, PacketID, PayloadID, RPCID, SpawnID } from "./constants/Enums.js"
import { DisconnectMessages } from "./constants/DisconnectMessages.js"
import { runInThisContext } from "vm"
import { Code2Int } from "./util/Codes.js"
import { Game } from "./struct/Game.js"
import { ppid } from "process"
import { bitfield } from "./interfaces/Types.js"
import { JoinOptions } from "./interfaces/JoinOptions.js"

import { Player } from "./struct/objects/Player.js"
import { GameData } from "./struct/objects/GameData.js"

import { Component } from "./struct/components/Component.js"
import { PlayerClient } from "./struct/PlayerClient.js"
import { PlayerControl } from "./struct/components/PlayerControl.js"
import { MeetingHud } from "./struct/components/MeetingHud.js"
import { LobbyBehaviour } from "./struct/objects/LobbyBehaviour.js"

export declare interface AmongusClient {
    on(event: "packet", listener: (packet: Packet) => void);
    off(event: "packet", listener: (packet: Packet) => void);
    on(event: "disconnect", listener: () => void);
    off(event: "disconnect", listener: () => void);
    on(event: "connected", listener: () => void);
    off(event: "connected", listener: () => void);
}

export type AnyObject = Player | GameData;

export class AmongusClient extends EventEmitter {
    options: ClientOptions;
    socket: dgram.Socket;
    ip: string;
    port: number;
    nonce: number;
    username: string;

    game: Game;
    clientid: number;

    constructor (options: ClientOptions = {}) {
        super();

        this.options = options;
        this.nonce = 1;

        this.game = null;
    }

    debug(...fmt) {
        if (this.options.debug) {
            console.log(...fmt);
        }
    }

    _disconnect() {
        this.emit("disconnect");
        
        this.socket.removeAllListeners();

        this.socket = null;
        this.ip = null;
        this.port = null;

        this.nonce = 1;
    }

    async disconnect(reason?: number, message?: string) {
        if (reason) {
            if (reason === DisconnectID.Custom) {
                if (message) {
                    await this.send({
                        op: PacketID.Disconnect,
                        reason: reason,
                        message: message
                    });
                } else {
                    await this.send({
                        op: PacketID.Disconnect,
                        reason: reason
                    });
                }
            } else {
                await this.send({
                    op: PacketID.Disconnect,
                    reason: reason
                });
            }
        } else {
            await this.send({
                op: PacketID.Disconnect
            });
        }

        await this.awaitPacket(packet => packet.op === PacketID.Disconnect);

        this._disconnect();
    }
    
    _connect(ip: string, port: number) {
        this.socket = dgram.createSocket("udp4");
        this.ip = ip;
        this.port = port;
        
        this.nonce = 1;

        this.socket.on("message", async buffer => {
            this.debug("Recieved packet", buffer);

            const packet = parsePacket(buffer);

            if (packet.reliable) {
                await this.ack(packet.nonce);
            }

            this.debug(util.inspect(packet, false, 10, true));

            if (packet.bound === "client") {
                switch (packet.op) {
                    case PacketID.Unreliable:
                    case PacketID.Reliable:
                        for (let i = 0; i < packet.payloads.length; i++) {
                            const payload = packet.payloads[i];

                            switch (payload.payloadid) {
                                case PayloadID.JoinGame:
                                    if (payload.bound === "client") {
                                        switch (payload.error) {  // Couldn't get typings to work with if statements so I have to deal with switch/case..
                                            case false:
                                                if (payload.code === this.game.code) {
                                                    const client = new PlayerClient(this, payload.clientid);

                                                    this.game.clients.set(client.clientid, client);
                                                    this.game.emit("playerJoin", client);
                                                }
                                                break;
                                        }
                                    }
                                    break;
                                case PayloadID.StartGame:
                                    if (payload.code === this.game.code) {
                                        this.game.emit("start");

                                        this.game.started = true;

                                        await this.send({
                                            op: PacketID.Reliable,
                                            payloads: [
                                                {
                                                    payloadid: PayloadID.GameData,
                                                    code: this.game.code,
                                                    parts: [
                                                        {
                                                            type: MessageID.Ready,
                                                            clientid: this.clientid
                                                        }
                                                    ]
                                                }
                                            ]
                                        });
                                    }
                                    break;
                                case PayloadID.EndGame:
                                    if (payload.code === this.game.code) {
                                        this.game.emit("finish");

                                        this.game.started = false;
                                    }
                                    break;
                                case PayloadID.RemovePlayer:
                                    if (payload.code === this.game.code) {
                                        const client = this.game.clients.get(payload.clientid);
                                        
                                        if (client) {
                                            client.removed = true;

                                            this.game.clients.delete(payload.clientid);
                                            this.game.emit("playerLeave", client);
                                        }
                                    }
                                    break;
                                case PayloadID.JoinedGame:
                                    this.game = new Game(this, payload.code, payload.hostid, [payload.clientid, ...payload.clients]);
                                    this.clientid = payload.clientid;
                                    break;
                                case PayloadID.KickPlayer:
                                    if (payload.bound === "client") {
                                        if (payload.code === this.game.code) {
                                            const client = this.game.clients.get(payload.clientid);

                                            if (client) {
                                                client.emit("kicked", payload.banned);
                                            }
                                        }
                                    }
                                    break;
                                case PayloadID.GameData:
                                case PayloadID.GameDataTo:
                                    if (this.game.code === payload.code) {
                                        for (let i = 0; i < payload.parts.length; i++) {
                                            const part = payload.parts[i];

                                            switch (part.type) {
                                                case MessageID.Data:
                                                    const component = this.game.netcomponents.get(part.netid);

                                                    if (component) {
                                                        component.OnDeserialize(part.datalen, part.data);
                                                    }
                                                    break;
                                                case MessageID.RPC:
                                                    switch (part.rpcid) {
                                                        case RPCID.CompleteTask:
                                                            break;
                                                        case RPCID.SyncSettings:
                                                            this.game._syncSettings(part.options);
                                                            break
                                                        case RPCID.SetInfected:
                                                            this.game.setImposters(part.infected);
                                                            break;
                                                        case RPCID.MurderPlayer: {
                                                            const client = this.game.getPlayerByNetID(part.targetnetid);
                                                            const murderer = this.game.getPlayerByNetID(part.handlerid);
                                                            
                                                            if (client && murderer) {
                                                                client.dead = true;

                                                                this.game.emit("murder", murderer, client);
                                                                client.emit("murdered", murderer);
                                                                murderer.emit("murder", client);
                                                            }
                                                            break;
                                                        }
                                                        case RPCID.StartMeeting:
                                                            const handlerid = part.handlerid;
                                                            const handler = this.game.netcomponents.get(handlerid);

                                                            console.log(handler);

                                                            if (part.targetid === 0xFF) {
                                                                this.game.emit("startMeeting", true, null);
                                                            } else {
                                                                const target = this.game.getPlayer(part.targetid);

                                                                this.game.emit("startMeeting", false, target);
                                                            }
                                                            break;
                                                        case RPCID.SetStartCounter:
                                                            if (this.game.startCounterSeq === null || part.sequence > this.game.startCounterSeq) {
                                                                this.game.startCount = part.time;
                                                                this.game.emit("startCount", this.game.startCount);
                                                            }
                                                            break;
                                                        case RPCID.VotingComplete:
                                                            if (part.tie) {
                                                                this.game.emit("votingComplete", false, true, null);
                                                            } else if (part.exiled === 0xFF) {
                                                                this.game.emit("votingComplete", true, false, null);
                                                            } else {
                                                                this.game.emit("votingComplete", false, false, this.game.getPlayer(part.exiled));
                                                            }
                                                            break;
                                                        case RPCID.CastVote: {
                                                            const client = this.game.getPlayer(part.voterid);
                                                            const suspect = this.game.getPlayer(part.suspectid);

                                                            this.game.emit("vote", client, suspect);
                                                            client.emit("vote", suspect);
                                                            break;
                                                        }
                                                        case RPCID.SetTasks:
                                                            const client = this.game.getPlayer(part.playerid);

                                                            if (client) {
                                                                client._setTasks(part.tasks);
                                                            }
                                                            break;
                                                        case RPCID.UpdateGameData:
                                                            this.game.GameData.GameData.UpdatePlayers(part.players);
                                                            break;
                                                    }
                                                    break;
                                                case MessageID.Spawn:
                                                    switch (part.spawnid) {
                                                        case SpawnID.ShipStatus:
                                                            // new ShipStatus(this, this.game, part.components);
                                                            break;
                                                        case SpawnID.MeetingHub:
                                                            // new MeetingHub(this, this.game, part.components);
                                                            break;
                                                        case SpawnID.LobbyBehaviour:
                                                            new LobbyBehaviour(this, this.game, part.components)
                                                            break;
                                                        case SpawnID.GameData:
                                                            new GameData(this, this.game, part.components);
                                                            break;
                                                        case SpawnID.Player:
                                                            const playerclient = this.game.clients.get(part.ownerid);

                                                            new Player(this, playerclient, part.components);
                                                            break;
                                                        case SpawnID.HeadQuarters:
                                                            // new HeadQuarters(this, this.game, part.components);
                                                            break;
                                                        case SpawnID.PlanetMap:
                                                            // new PlanetMap(this, this.game, part.components);
                                                            break;
                                                        case SpawnID.AprilShipStatus:
                                                            // new AprilShipStatus(this, this.game, part.components);
                                                            break;
                                                    }
                                                    break;
                                                case MessageID.Despawn:
                                                    this.game.netcomponents.delete(part.netid);
                                                    break;
                                            }
                                        }
                                    }
                                    break;
                            }
                            break;
                        }
                        break;
                }
            }

            this.emit("packet", packet);
        });
    }

    async connect(ip: string, port: number, username: string): Promise<boolean|number> {
        if (this.socket) {
            await this.disconnect();
        }

        this._connect(ip, port);

        if (await this.hello(username)) {
            this.emit("connected");

            return true;
        }

        return false;
    }

    _send(buffer: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket.send(buffer, this.port, this.ip, err => {
                if (err) return reject(err);

                resolve();
            });
        });
    }

    awaitPacket(filter: (packet: Packet) => boolean): Promise<Packet|null> {
        const _this = this;

        return new Promise((resolve, reject) => {
            function onPacket(packet) {
                if (filter(packet)) {
                    _this.off("disconnect", onDisconnect);
                    _this.off("packet", onPacket);

                    resolve(packet);
                }
            }

            function onDisconnect() {
                _this.off("disconnect", onDisconnect);
                _this.off("packet", onPacket);

                resolve(null);
            }

            this.on("packet", onPacket);
            this.on("disconnect", onDisconnect);
        });
    }

    async awaitPayload(filter: (payload: Payload) => boolean): Promise<Payload|null> {
        const packet = await this.awaitPacket(packet => {
            return (packet.op === PacketID.Unreliable || packet.op === PacketID.Reliable)
                && packet.bound === "client"
                && packet.payloads.some(payload => filter(payload));
        });

        if (packet.op === PacketID.Unreliable || packet.op === PacketID.Reliable) {
            if (packet.bound === "client") {
                return packet.payloads.find(payload => filter(payload));
            }
        }

        return null;
    }

    async send(packet: Packet): Promise<boolean> {
        const nonce = this.nonce;

        switch (packet.op) {
            case PacketID.Reliable:
            case PacketID.Hello:
            case PacketID.Ping:
                packet.reliable = true;
                packet.nonce = nonce;
                this.nonce++;
                break;
        }
        
        const composed = composePacket(packet, "server");
        
        await this._send(composed);
        
        this.debug("Sent packet", composed);

        if (packet.reliable) {
            const interval = setInterval(() => {
                this._send(composed);
            }, this.options.ackInterval || 1500);

            this.debug("Awaiting acknowledege", nonce);

            const ack = await this.awaitPacket(packet => {
                return packet.op === PacketID.Acknowledge
                    && packet.nonce === nonce;
            });
            
            this.debug("Recieved acknowledege", nonce);

            clearInterval(interval);

            return ack !== null;
        } else {
            return true;
        }
    }

    async ack(nonce: number): Promise<void> { 
        await this.send({
            op: PacketID.Acknowledge,
            nonce
        });
    }

    async hello(username: string): Promise<boolean> {
        if (await this.send({
            op: PacketID.Hello,
            username: username
        })) {
            this.username = username;
            
            return true;
        }

        return false;
    }

    async join(code: string|number, options: JoinOptions = {}): Promise<Game> {
        if (typeof code === "string") {
            return this.join(Code2Int(code));
        }

        if (this.game) {
            throw new Error("Join Error: You are already in a game. Please leave or end your current game before playing another.");
        }

        await this.send({
            op: PacketID.Reliable,
            payloads: [
                {
                    payloadid: PayloadID.JoinGame,
                    code: code,
                    mapOwnership: 0x07
                }
            ]
        });

        const payload = await Promise.race([
            this.awaitPayload(p => p.payloadid === PayloadID.Redirect),
            this.awaitPayload(p => p.payloadid === PayloadID.JoinedGame),
            this.awaitPayload(p => p.payloadid === PayloadID.JoinGame)
        ]);

        if (payload.payloadid === PayloadID.Redirect) {
            await this.disconnect();

            await this.connect(payload.ip, payload.port, this.username);

            return await this.join(code);
        } else if (payload.payloadid === PayloadID.JoinedGame) {
            if (options.doSpawn ?? true) {
                await this.send({
                    op: PacketID.Reliable,
                    payloads: [
                        {
                            payloadid: PayloadID.GameData,
                            code: payload.code,
                            parts: [
                                {
                                    type: MessageID.SceneChange,
                                    clientid: payload.clientid,
                                    location: "OnlineGame"
                                }
                            ]
                        }
                    ]
                });
            }

            return this.game;
        } else if (payload.payloadid === PayloadID.JoinGame) {
            if (payload.bound === "client" && payload.error) {
                throw new Error("Join error: " + payload.reason + " (" + payload.message + ")");
            }
        }
    }
    
    async search(maps: bitfield|MapID[] = 0x07, imposters: number = 0, language: LanguageID = LanguageID.Any): Promise<GameListGame[]> {
        if (Array.isArray(maps)) {
            return await this.search(maps.reduce((val, map) => val + (1 << map), 0), imposters, language);
        }

        await this.send({
            op: PacketID.Reliable,
            payloads: [
                {
                    payloadid: PayloadID.GetGameListV2,
                    bound: "server",
                    options: {
                        mapID: maps,
                        imposterCount: imposters,
                        language
                    }
                }
            ]
        });

        const payload = await Promise.race([
            this.awaitPayload(p => p.payloadid === PayloadID.Redirect),
            this.awaitPayload(p => p.payloadid === PayloadID.GetGameListV2)
        ]);

        if (payload.payloadid === PayloadID.Redirect) {
            await this.disconnect();

            await this.connect(payload.ip, payload.port, this.username);

            return await this.search(maps, imposters, language);
        } else if (payload.bound === "client" && payload.payloadid === PayloadID.GetGameListV2) {
            return payload.games;
        }

        return null;
    }

    async host(options: Partial<GameOptionsData> = {}) {
        options = {
            version: 2,
            mapID: MapID.TheSkeld,
            imposterCount: 1,
            confirmEjects: true,
            emergencies: 1,
            emergencyCooldown: 15,
            discussionTime: 15,
            votingTime: 120,
            playerSpeed: 1,
            crewVision: 1,
            imposterVision: 1.5,
            killCooldown: 45,
            killDistance: DistanceID.Medium,
            visualTasks: true,
            commonTasks: 1,
            longTasks: 1,
            shortTasks: 2,
            ...options
        };

        await this.send({
            op: PacketID.Reliable,
            payloads: [
                {
                    payloadid: PayloadID.HostGame,
                    options
                }
            ]
        });

        const payload = await Promise.race([
            this.awaitPayload(p => p.payloadid === PayloadID.Redirect),
            this.awaitPayload(p => p.payloadid === PayloadID.HostGame),
            this.awaitPayload(p => p.payloadid === PayloadID.JoinGame)
        ]);

        if (payload.bound === "client") {
            if (payload.payloadid === PayloadID.Redirect) {
                await this.disconnect();

                await this.connect(payload.ip, payload.port, this.username);

                return await this.host(options);
            } else if (payload.payloadid === PayloadID.HostGame) {
                return payload.code;
            } else if (payload.payloadid === PayloadID.JoinGame) {
                if (payload.error) {
                    throw new Error("Join error: " + payload.reason + " (" + payload.message + ")");
                }
            }
        }
    }
}