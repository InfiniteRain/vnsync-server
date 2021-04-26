import { Server, Socket } from "socket.io";
import { Connection } from "./interfaces/Connection";

export const roomExists = (io: Server, roomName: string): boolean =>
  !!io.sockets.adapter.rooms.get(roomName);

export const getRoomMembers = (
  io: Server,
  roomName: string
): Map<string, Socket> => {
  const membersSet = io.sockets.adapter.rooms.get(roomName);

  if (!membersSet) {
    console.trace("here");
    throw new Error("Room doesn't exist.");
  }

  const members = new Map<string, Socket>();

  for (const memberId of membersSet.values()) {
    members.set(memberId, getClientById(io, memberId));
  }

  return members;
};

export const getRoomConnections = (
  io: Server,
  connections: Map<string, Connection>,
  roomName: string
): Connection[] => {
  const connectionsArray: Connection[] = [];

  for (const member of getRoomMembers(io, roomName).values()) {
    const connection = connections.get(member.id);

    if (!connection) {
      throw new Error("Member connection not found in the connections list.");
    }

    connectionsArray.push(connection);
  }

  return connectionsArray;
};

export const getClientById = (io: Server, id: string): Socket => {
  const client = io.of("/").sockets.get(id);

  if (!client) {
    throw new Error("Client doesn't exist.");
  }

  return client;
};
