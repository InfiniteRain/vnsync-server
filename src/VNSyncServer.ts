import express from "express";
import path from "path";
import { createServer, Server as HTTPServer } from "http";
import { Server, Socket } from "socket.io";
import { Connection } from "./interfaces/Connection";
import { EventResult } from "./interfaces/EventResult";
import { Room } from "./interfaces/Room";
import { cloneDeep } from "lodash";
import { Logger } from "loglevel";

export class VNSyncServer {
  private readonly expressApp = express();
  private readonly httpServer: HTTPServer;
  private readonly wsServer: Server;

  private readonly connections: Map<string, Connection> = new Map();
  private readonly rooms: Map<string, Room> = new Map();

  private disconnectResolve: (() => void) | null = null;

  public constructor(private log: Logger) {
    // todo: remove / refactor this
    this.expressApp.get(/^(?!\/pensive.svg$).*/, (_, res) => {
      res.sendFile(path.join(__dirname + "/../assets/index.html"));
    });

    this.expressApp.get("/pensive.svg", (_, res) => {
      res.sendFile(path.join(__dirname + "/../assets/pensive.svg"));
    });

    this.httpServer = createServer(this.expressApp);
    this.wsServer = new Server(this.httpServer);

    this.initServer();
  }

  public start(port: number, silent = false): void {
    if (!silent) {
      this.log.info(`The server is running on port ${port}...`);
    }

    this.httpServer.listen(port);
  }

  public close(): void {
    this.log.info("Closing the server...");

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
    this.log.info("Initializing the server...");

    this.wsServer.on("connection", (socket) => {
      this.log.info(`Socket ${socket.id}: connected`);

      socket.on("createRoom", (...args: unknown[]) => {
        const callback = args.pop() as (result: EventResult<string>) => void;
        const result = this.onCreateRoom(socket, ...args);

        this.log.info(`Event createRoom emitted by ${socket.id}:`, result);

        callback(result);
      });

      socket.on("joinRoom", (...args: unknown[]) => {
        const callback = args.pop() as (result: EventResult<undefined>) => void;
        const result = this.onJoinRoom(socket, ...args);

        this.log.info(`Event joinRoom emitted by ${socket.id}:`, result);

        callback(result);
      });

      socket.on("toggleReady", (...args: unknown[]) => {
        const callback = args.pop() as (result: EventResult<undefined>) => void;
        const result = this.onToggleReady(socket);

        this.log.info(`Event toggleReady emitted by ${socket.id}:`, result);

        callback(result);
      });

      socket.on("disconnect", () => {
        this.log.info(`Socket ${socket.id}: disconnected`);

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
    const connection = {
      username,
      isHost: true,
      room: roomName,
      socket,
      isReady: false,
    };

    this.connections.set(socket.id, connection);
    this.rooms.set(roomName, { connections: [connection], host: connection });
    socket.join(roomName);
    this.emitStateChange(roomName);

    this.log.info(`User ${username}: created room ${roomName}`);

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

    const connection = {
      username,
      isHost: false,
      room: roomName,
      socket,
      isReady: false,
    };

    this.connections.set(socket.id, connection);
    room.connections.push(connection);
    socket.join(roomName);
    this.emitStateChange(roomName);

    this.log.info(`User ${username}: joined room ${roomName}`);

    return {
      status: "ok",
    };
  }

  private onToggleReady(socket: Socket): EventResult<undefined> {
    if (!this.isInARoom(socket.id)) {
      return {
        status: "fail",
        failMessage: "This user is not yet in a room.",
      };
    }

    const connection = this.connections.get(socket.id);

    if (!connection) {
      throw new Error("The connection is not present in the connections map.");
    }

    connection.isReady = !connection.isReady;
    this.entireRoomReadyCheck(connection.room);
    this.emitStateChange(connection.room);

    this.log.info(
      `User ${connection.room}/${connection.username}: toggled state`
    );

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

      this.log.info(`Room ${connection.room}: deleted`);
    }

    // Emit a state change event if not host.
    if (!connection.isHost) {
      this.entireRoomReadyCheck(connection.room);
      this.emitStateChange(connection.room);
    }

    this.connections.delete(socket.id);

    this.log.info(`User ${connection.room}/${connection.username}: left`);
  }

  private emitStateChange(roomName: string) {
    const room = this.rooms.get(roomName);

    if (!room) {
      throw new Error(`Room "${roomName}" doesn't exist.`);
    }

    const state = room.connections.map((roomConnection) => ({
      username: roomConnection.username,
      isReady: roomConnection.isReady,
      isHost: roomConnection.isHost,
    }));

    this.wsServer.in(roomName).emit("roomStateChange", state);

    this.log.info(`Room ${roomName}: state changed`, state);
  }

  private entireRoomReadyCheck(roomName: string): void {
    const room = this.rooms.get(roomName);

    if (!room) {
      throw new Error("The room is not present in the rooms map.");
    }

    if (room.connections.length === 0) {
      return;
    }

    const everyoneIsReady = room.connections.reduce(
      (previousValue, currentValue) => previousValue && currentValue.isReady,
      room.connections[0].isReady
    );

    if (!everyoneIsReady) {
      return;
    }

    for (const roomConnection of room.connections) {
      roomConnection.isReady = false;
    }

    this.wsServer.to(room.host.socket.id).emit("roomReady");

    this.log.info(`Room ${roomName}: emitted room ready to host`);
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
