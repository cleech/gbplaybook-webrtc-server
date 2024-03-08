import type { ServerWebSocket } from "bun";
import * as uuid from "uuid";

const PORT: number = +(process.env.PORT || 8081);
const NODE_ENV = process.env.NODE_ENV ?? "development";

interface ServerPeer {
  id: string;
  rooms: Set<string>;
  lastPing: number;
}

export type SimplePeerInitMessage = {
  type: "init";
  yourPeerId: string;
};
export type SimplePeerJoinMessage = {
  type: "join";
  room: string;
};
export type SimplePeerJoinedMessage = {
  type: "joined";
  otherPeerIds: string[];
};
export type SimplePeerSignalMessage = {
  type: "signal";
  room: string;
  senderPeerId: string;
  receiverPeerId: string;
  data: string;
};
export type SimplePeerPingMessage = {
  type: "ping";
};

export type PeerMessage =
  // These Need to stay compatible with rxdb-plugin-replication-webrtc
  | SimplePeerInitMessage
  | SimplePeerJoinMessage
  | SimplePeerJoinedMessage
  | SimplePeerSignalMessage
  | SimplePeerPingMessage;
  // These are my extensions for the pre-replication handshake
  // | SimplePeerHandshakeInitMessage
  // | SimplePeerHandshakeJoinMessage
  // | SimplePeerHandshakeResponseMessage

const peerById = new Map<string, ServerWebSocket<ServerPeer>>();
const peersByRoom = new Map<string, Set<string>>();

const server = Bun.serve<ServerPeer>({
  port: PORT,
  fetch(req, server) {
    if (
      server.upgrade(req, {
        data: {
          id: uuid.v4(),
          rooms: new Set(),
          lastPing: Date.now(),
        },
      })
    ) {
      return;
    }
    return new Response(null, { status: 404 });
  },
  websocket: {
    message(ws, msg: string) {
      const peer = ws.data;
      const peerId = peer.id;
      peer.lastPing = Date.now();
      const message = JSON.parse(msg.toString()) as PeerMessage;
      const type = message.type;
      switch (type) {
        case "join":
          const roomId = message.room;
          if (!uuid.validate(roomId)) {
            ws.close(undefined, "Invalid ID");
            return;
          }
          peer.rooms.add(roomId);
          let room = peersByRoom.get(roomId);
          if (!room) {
            room = new Set();
            peersByRoom.set(roomId, room);
          }
          room.add(peerId);
          ws.subscribe(roomId);
          server.publish(
            roomId,
            JSON.stringify({ type: "joined", otherPeerIds: Array.from(room) })
          );
          break;
        case "signal":
          if (message.senderPeerId !== peerId) {
            return;
          }
          const receiver = peerById.get(message.receiverPeerId);
          if (receiver) {
            sendMessage(receiver, message);
          }
          break;
        case "ping":
          break;
        default:
      }
    },
    open(ws) {
      const peerId = ws.data.id;
      console.log(`# connected peer ${peerId}`);
      peerById.set(peerId, ws);
      sendMessage(ws, { type: "init", yourPeerId: peerId });
    },
    close(ws, code, reason) {
      const peer = ws.data;
      const peerId = peer.id;
      console.log(`# disconnect peer ${peerId} reason: ${reason}`);
      peer.rooms.forEach((roomId) => {
        const room = peersByRoom.get(roomId);
        room?.delete(peerId);
        ws.unsubscribe(roomId);
      });
      peerById.delete(peerId);
    },
  },
});

function sendMessage(ws: ServerWebSocket<ServerPeer>, msg: PeerMessage) {
  const message = JSON.stringify(msg);
  ws.send(message);
}

console.log(`[${NODE_ENV}] Serving http://localhost:${server.port}`);
