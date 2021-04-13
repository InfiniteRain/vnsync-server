import express from "express";
import path from "path";
import { createServer, Server as HTTPServer } from "http";
import { Server, Socket } from "socket.io";
import { Connection } from "./interfaces/Connection";
import { EventResult } from "./interfaces/EventResult";
import { Room } from "./interfaces/Room";
import { cloneDeep } from "lodash";
import { Logger } from "loglevel";
import { Configuration } from "./interfaces/Configuration";

/**
 * Default configuration.
 */
const defaultConfiguration: Configuration = {
  maxConnectionsFromSingleSource: Number.parseInt(
    process.env.MAX_CONNECTIONS_FROM_SINGLE_SOURCE || "5"
  ),
};

/**
 * VNSyncServer class.
 *
 * Represents a VNSync server.
 */
export class VNSyncServer {
  /**
   * Express instance.
   */
  private readonly expressApp = express();

  /**
   * HTTP server instance.
   */
  private readonly httpServer: HTTPServer;

  /**
   * Socket.io server instance.
   */
  private readonly wsServer: Server;

  /**
   * Current connections.
   */
  private readonly connections: Map<string, Connection> = new Map();

  /**
   * Current rooms.
   */
  private readonly rooms: Map<string, Room> = new Map();

  /**
   * This map represents the amount of connections made from a single ip
   * address.
   */
  private readonly addresses: Map<string, number> = new Map();

  /**
   * A resolve function for a disconnect promise.
   * Used only for tests.
   */
  private disconnectResolve: (() => void) | null = null;

  /**
   * Constructor.
   *
   * @param log A loglevel object.
   * @param configuration Configuration object for the server.
   */
  public constructor(
    private log: Logger,
    private configuration: Configuration = defaultConfiguration
  ) {
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

  /**
   * Starts the WebSocket server.
   *
   * @param port The port to listen to.
   */
  public start(port: number): void {
    this.log.info(`The server is running on port ${port}...`);

    this.httpServer.listen(port);
  }

  /**
   * Closes the server.
   */
  public close(): void {
    this.log.info("Closing the server...");

    this.wsServer.close();
    this.httpServer.close();
  }

  /**
   * Gets a snapshot of current connections, deeply cloned.
   * Used only for tests.
   */
  public get connectionsSnapshot(): Map<string, Connection> {
    return cloneDeep(this.connections);
  }

  /**
   * Gets a snapshot of current rooms, deeply cloned.
   * Used only for tests.
   */
  public get roomsSnapshot(): Map<string, Room> {
    return cloneDeep(this.rooms);
  }

  /**
   * Gets a snapshot of current addresses, deeply cloned.
   * Used only for tests.
   */
  public get addressesSnapshot(): Map<string, number> {
    return cloneDeep(this.addresses);
  }

  /**
   * Returns a promise that resolves once the next disconnection event cycle
   * completes.
   * Used only for tests.
   *
   * @returns The disconnection promise.
   */
  public awaitForDisconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.disconnectResolve = resolve;
    });
  }

  /**
   * Initializes the WebSocket server.
   */
  private initServer(): void {
    this.log.info("Initializing the server...");

    this.wsServer
      .use((socket, next) => {
        if (this.isAddressBlocked(socket.handshake.address)) {
          next(new Error("Too many connections from the same address."));
          return;
        }

        next();
      })
      .on("connection", (socket) => {
        this.log.info(`Socket ${socket.id}: connecting...`);

        this.addAddress(socket.handshake.address);

        socket.on("createRoom", (...args: unknown[]) => {
          const callback = args.pop() as (result: EventResult<string>) => void;
          const result = this.onCreateRoom(socket, ...args);

          this.log.info(`Event createRoom emitted by ${socket.id}:`, result);

          callback(result);
        });

        socket.on("joinRoom", (...args: unknown[]) => {
          const callback = args.pop() as (
            result: EventResult<undefined>
          ) => void;
          const result = this.onJoinRoom(socket, ...args);

          this.log.info(`Event joinRoom emitted by ${socket.id}:`, result);

          callback(result);
        });

        socket.on("toggleReady", (...args: unknown[]) => {
          const callback = args.pop() as (
            result: EventResult<undefined>
          ) => void;
          const result = this.onToggleReady(socket);

          this.log.info(`Event toggleReady emitted by ${socket.id}:`, result);

          callback(result);
        });

        socket.on("disconnect", () => {
          this.log.info(`Socket ${socket.id}: disconnected`);

          this.onDisconnect(socket);
          this.removeAddress(socket.handshake.address);

          if (this.disconnectResolve !== null) {
            this.disconnectResolve();
            this.disconnectResolve = null;
          }
        });

        this.log.info(`Socket ${socket.id}: connected`);
      });
  }

  /**
   * Method that gets triggered on "createRoom" event.
   *
   * @param socket The socket that triggered the event.
   * @param args Arguments passed to the event.
   * @returns The event result.
   */
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
      roomName,
      socket,
      isReady: false,
    };

    this.connections.set(socket.id, connection);
    this.rooms.set(roomName, { connections: [connection], host: connection });
    socket.join(roomName);
    this.emitRoomStateChange(roomName);

    this.log.info(`User ${username}: created room ${roomName}`);

    return {
      status: "ok",
      data: roomName,
    };
  }

  /**
   * Method that gets triggered on "joinRoom" event.
   *
   * @param socket The socket that triggered the event.
   * @param args Arguments passed to the event.
   * @returns The event result.
   */
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
      roomName,
      socket,
      isReady: false,
    };

    this.connections.set(socket.id, connection);
    room.connections.push(connection);
    socket.join(roomName);
    this.emitRoomStateChange(roomName);

    this.log.info(`User ${username}: joined room ${roomName}`);

    return {
      status: "ok",
    };
  }

  /**
   * Method that gets triggered on "toggleReady" event.
   *
   * @param socket The socket that triggered the event.
   * @returns The event result.
   */
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
    this.entireRoomReadyCheck(connection.roomName);
    this.emitRoomStateChange(connection.roomName);

    this.log.info(
      `User ${connection.roomName}/${connection.username}: toggled state`
    );

    return {
      status: "ok",
    };
  }

  /**
   * Method that gets triggered on "disconnect" event.
   *
   * @param socket The socket that triggered the event.
   * @returns The event result.
   */
  private onDisconnect(socket: Socket): void {
    const connection = this.connections.get(socket.id);
    const room = this.rooms.get(connection?.roomName || "");

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

      this.rooms.delete(connection.roomName);

      this.log.info(`Room ${connection.roomName}: deleted`);
    }

    // Emit a state change event if not host.
    if (!connection.isHost) {
      this.entireRoomReadyCheck(connection.roomName);
      this.emitRoomStateChange(connection.roomName);
    }

    this.connections.delete(socket.id);

    this.log.info(`User ${connection.roomName}/${connection.username}: left`);
  }

  /**
   * Checks if the address is blocked. The adress is considered blocked when
   * there are too many connections from it.
   *
   * @param address The address in question.
   * @returns A boolean depending on whether the address is blocked or not.
   */
  private isAddressBlocked(address: string): boolean {
    const count = this.addresses.get(address);

    if (count === undefined) {
      return false;
    }

    return count >= this.configuration.maxConnectionsFromSingleSource;
  }

  /**
   * Adds an address to the addresses map.
   *
   * @param address The address to add.
   */
  private addAddress(address: string): void {
    const count = this.addresses.get(address);

    if (count === undefined) {
      this.addresses.set(address, 1);

      return;
    }

    this.addresses.set(address, count + 1);
  }

  /**
   * Removes an address from the addresses map.
   *
   * @param address The address to remove.
   */
  private removeAddress(address: string): void {
    const count = this.addresses.get(address);

    if (count === undefined) {
      throw new Error("The address is not present in the addresses map.");
    }

    if (count - 1 <= 0) {
      this.addresses.delete(address);

      return;
    }

    this.addresses.set(address, count - 1);
  }

  /**
   * Emits a "roomStateChange" event.
   *
   * @param roomName The name of the room to emit the update to.
   */
  private emitRoomStateChange(roomName: string): void {
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

  /**
   * Checks if the entire room is ready. If it is, resets the ready state of
   * everyone in the room and emits a "roomReady" event to the host.
   *
   * @param roomName The name of the room to check.
   */
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

  /**
   * Checks if a connection is a part of a room.
   *
   * @param socketId The socket id of the connection in question.
   * @returns A boolean depending on whether the connection is in a room or
   * not.
   */
  private isInARoom(socketId: string): boolean {
    return this.connections.has(socketId);
  }

  /**
   * Generates a unique name for a room.
   *
   * @returns The generated name string.
   */
  private generateRoomName(): string {
    let roomName;

    do {
      roomName = Math.random().toString(36).substring(2, 15);
    } while (this.rooms.has(roomName));

    return roomName;
  }
}
