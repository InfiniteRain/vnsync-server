import express from "express";
import { createServer, Server as HTTPServer } from "http";
import { Server, Socket } from "socket.io";
import { Connection } from "./interfaces/Connection";
import { EventResult } from "./interfaces/EventResult";
import { Room } from "./interfaces/Room";
import { cloneDeep } from "lodash";

export class VNSyncServer {
  private readonly expressApp = express();
  private readonly httpServer: HTTPServer;
  private readonly wsServer: Server;

  private readonly connections: Map<string, Connection> = new Map();
  private readonly rooms: Map<string, Room> = new Map();

  private disconnectResolve: (() => void) | null = null;

  public constructor() {
    this.httpServer = createServer(this.expressApp);
    this.wsServer = new Server(this.httpServer);

    this.initServer();
  }

  public start(port: number, silent = false): void {
    if (!silent) {
      console.log(`The server is running on port ${port}...`);
    }

    this.httpServer.listen(port);
  }

  public close(): void {
    this.wsServer.close();
    this.httpServer.close();
  }

  public get connectionsSnapshot(): Map<string, Connection> {
    return cloneDeep(this.connections);
  }

  public get roomsSnapshot(): Map<string, Room> {
    return cloneDeep(this.rooms);
  }

  public awaitForDisconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.disconnectResolve = resolve;
    });
  }

  private initServer(): void {
    this.wsServer.on("connection", (socket) => {
      socket.on("createRoom", (...args: unknown[]) => {
        const callback = args.pop() as (result: EventResult<string>) => void;
        callback(this.onCreateRoom(socket, ...args));
      });

      socket.on("joinRoom", (...args: unknown[]) => {
        const callback = args.pop() as (result: EventResult<undefined>) => void;
        callback(this.onJoinRoom(socket, ...args));
      });

      socket.on("disconnect", () => {
        this.onDisconnect(socket);

        if (this.disconnectResolve !== null) {
          this.disconnectResolve();
          this.disconnectResolve = null;
        }
      });
    });
  }

  private onCreateRoom(
    socket: Socket,
    ...args: unknown[]
  ): EventResult<string> {
    if (this.isInARoom(socket.id)) {
      return {
        status: "fail",
        failMessage: "This user is already in a room.",
      };
    }

    const username = args[0] as string;

    if (typeof username !== "string" || username === "") {
      return {
        status: "fail",
        failMessage: "Username should be a non-empty string.",
      };
    }

    const roomName = this.generateRoomName();
    const connection = { username, isHost: true, room: roomName, socket };

    this.connections.set(socket.id, connection);
    this.rooms.set(roomName, { connections: [connection] });

    return {
      status: "ok",
      data: roomName,
    };
  }

  private onJoinRoom(
    socket: Socket,
    ...args: unknown[]
  ): EventResult<undefined> {
    if (this.isInARoom(socket.id)) {
      return {
        status: "fail",
        failMessage: "This user is already in a room.",
      };
    }

    const username = args[0] as string;

    if (typeof username !== "string" || username === "") {
      return {
        status: "fail",
        failMessage: "Username should be a non-empty string.",
      };
    }

    const roomName = args[1] as string;

    if (typeof roomName !== "string" || roomName === "") {
      return {
        status: "fail",
        failMessage: "Room name should be a non-empty string.",
      };
    }

    const room = this.rooms.get(roomName);

    if (!room) {
      return {
        status: "fail",
        failMessage: `Room "${roomName}" doesn't exist.`,
      };
    }

    for (const connection of room.connections) {
      if (connection.username === username) {
        return {
          status: "fail",
          failMessage: `Username "${username}" is already taken by someone else in this room.`,
        };
      }
    }

    const connection = { username, isHost: false, room: roomName, socket };

    this.connections.set(socket.id, connection);
    room.connections.push(connection);

    return {
      status: "ok",
    };
  }

  private onDisconnect(socket: Socket): void {
    const connection = this.connections.get(socket.id);
    const room = this.rooms.get(connection?.room || "");

    if (connection === undefined || room === undefined) {
      return;
    }

    // Update room's connections.
    room.connections = room.connections.filter(
      (roomConnection) => roomConnection.username !== connection.username
    );

    // Delete room and disconnect all users if host.
    if (connection.isHost) {
      for (const roomConnection of room.connections) {
        roomConnection.socket.disconnect();
      }

      this.rooms.delete(connection.room);
    }

    this.connections.delete(socket.id);
  }

  private isInARoom(socketId: string): boolean {
    return this.connections.has(socketId);
  }

  private generateRoomName(): string {
    let roomName;

    do {
      roomName = Math.random().toString(36).substring(2, 15);
    } while (this.rooms.has(roomName));

    return roomName;
  }
}
