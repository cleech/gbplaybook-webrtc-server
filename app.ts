import type { ServerWebSocket } from "bun";
import * as uuid from "uuid";

const PORT: number = +(process.env.PORT || 8081);
const NODE_ENV = process.env.NODE_ENV ?? "development";

interface ServerPeer {
  id: string;
  rooms: Set<string>;
  lastPing: number;
  // handshake protocol
  code: number;
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

export type HandshakeInitMessage = {
  type: "handshake-begin";
};
export type HandshakeResponseMessage = {
  type: "handshake-response";
  yourId: string;
  code: number;
};
export type HandshakeJoinMessage = {
  type: "handshake-join";
  code: number;
};
export type HandshakeCompleteMessage = {
  type: "handshake-complete";
  yourId: string;
  otherId: string;
};

export type PeerMessage =
  // These Need to stay compatible with rxdb-plugin-replication-webrtc
  | SimplePeerInitMessage
  | SimplePeerJoinMessage
  | SimplePeerJoinedMessage
  | SimplePeerSignalMessage
  | SimplePeerPingMessage
  // These are my extensions for the pre-replication handshake
  | HandshakeInitMessage
  | HandshakeJoinMessage
  | HandshakeResponseMessage
  | HandshakeCompleteMessage;

const peerById = new Map<string, ServerWebSocket<ServerPeer>>();
const peersByRoom = new Map<string, Set<string>>();

const peerByHandshake = new Map<number, ServerWebSocket<ServerPeer>>();

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
    return new Response(null, { status: 204 });
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
          {
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
          }
          break;
        case "signal":
          {
            if (message.senderPeerId !== peerId) {
              return;
            }
            const receiver = peerById.get(message.receiverPeerId);
            if (receiver) {
              sendMessage(receiver, message);
            }
          }
          break;
        case "ping":
          break;

        // handshake protocol
        case "handshake-begin":
          {
            let code;
            do {
              code = Math.floor(Math.random() * 9999);
            } while (peerByHandshake.has(code));

            peer.code = code;
            peerByHandshake.set(code, ws);

            sendMessage(ws, {
              type: "handshake-response",
              yourId: peerId,
              code: code,
            });
          }
          break;
        case "handshake-join":
          {
            const code = message.code;
            const peer = peerByHandshake.get(code);
            if (peer) {
              sendMessage(ws, {
                type: "handshake-complete",
                yourId: ws.data.id,
                otherId: peer.data.id,
              });
              sendMessage(peer, {
                type: "handshake-complete",
                yourId: peer.data.id,
                otherId: ws.data.id,
              });
              peerByHandshake.delete(code);
            }
          }
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
      // cleanup from unfinished handshake
      peerByHandshake.delete(peer.code);
    },
  },
});

function sendMessage(ws: ServerWebSocket<ServerPeer>, msg: PeerMessage) {
  const message = JSON.stringify(msg);
  ws.send(message);
}

console.log(`[${NODE_ENV}] Serving ws://localhost:${server.port}`);
