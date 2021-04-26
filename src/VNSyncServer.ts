import express from "express";
import path from "path";
import { createServer, Server as HTTPServer } from "http";
import { Server, Socket } from "socket.io";
import { Connection } from "./interfaces/Connection";
import { EventResult } from "./interfaces/EventResult";
import { cloneDeep } from "lodash";
import { Logger } from "loglevel";
import { Configuration } from "./interfaces/Configuration";
import { nonEmptyString, validateEventArguments } from "./eventValidator";
import { getRoomConnections, getRoomMembers, roomExists } from "./helpers";

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
  private readonly io: Server;

  /**
   * Current connections.
   */
  private readonly connections: Map<string, Connection> = new Map();

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
    this.io = new Server(this.httpServer, {
      cors: {
        origin: "*",
      },
    });

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

    this.io.close();
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
  public get roomsSnapshot(): Map<string, Set<string>> {
    return cloneDeep(this.io.sockets.adapter.rooms);
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

    this.io
      .use((socket, next) => {
        if (this.isAddressBlocked(socket.handshake.address)) {
          next(new Error("Too many connections from the same address."));
          return;
        }

        next();
      })
      .on("connection", (socket) => {
        this.log.info(`Socket ${socket.id}: connecting...`);

        const connection = {
          username: "",
          isHost: false,
          room: null,
          socket,
          isReady: false,
        };

        this.connections.set(socket.id, connection);
        this.addAddress(socket.handshake.address);

        socket.on("createRoom", (...args: unknown[]) => {
          const callback = args.pop() as (result: EventResult<string>) => void;
          const username = args[0] as string;
          const validationError =
            validateEventArguments<string>(
              [nonEmptyString("Username")],
              [username]
            ) || this.validateRoomPresence<string>(connection, false);

          if (validationError) {
            callback(validationError);
            return;
          }

          const result = this.onCreateRoom(socket, connection, username);

          this.log.info(`Event createRoom emitted by ${socket.id}:`, result);

          callback(result);
        });

        socket.on("joinRoom", (...args: unknown[]) => {
          const callback = args.pop() as (
            result: EventResult<undefined>
          ) => void;
          const username = args[0] as string;
          const roomName = args[1] as string;
          const validationError =
            validateEventArguments(
              [nonEmptyString("Username"), nonEmptyString("Room name")],
              [username, roomName]
            ) || this.validateRoomPresence(connection, false);

          if (validationError) {
            callback(validationError);
            return;
          }

          const result = this.onJoinRoom(
            socket,
            connection,
            username,
            roomName
          );

          this.log.info(`Event joinRoom emitted by ${socket.id}:`, result);

          callback(result);
        });

        socket.on("toggleReady", (...args: unknown[]) => {
          const callback = args.pop() as (
            result: EventResult<undefined>
          ) => void;
          const validationError = this.validateRoomPresence(connection, true);

          if (validationError) {
            callback(validationError);
            return;
          }

          const room = connection.room;

          if (!room) {
            throw new Error(
              "Connection is unexpectedly not present in any room."
            );
          }

          const result = this.onToggleReady(connection, room);

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
   * @param connection The connection of the socket that triggered the event.
   * @param username The username.
   * @returns The event result.
   */
  private onCreateRoom(
    socket: Socket,
    connection: Connection,
    username: string
  ): EventResult<string> {
    const roomName = this.generateRoomName();

    connection.username = username;
    connection.room = roomName;
    connection.isHost = true;

    socket.join(roomName);
    this.emitRoomStateChange(roomName);

    this.log.info(`Connection ${username}: created room ${roomName}`);

    return {
      status: "ok",
      data: roomName,
    };
  }

  /**
   * Method that gets triggered on "joinRoom" event.
   *
   * @param socket The socket that triggered the event.
   * @param connection The connection of the socket that triggered the event.
   * @param username The username.
   * @param roomName The room name.
   * @returns The event result.
   */
  private onJoinRoom(
    socket: Socket,
    connection: Connection,
    username: string,
    roomName: string
  ): EventResult<undefined> {
    const room = this.io.sockets.adapter.rooms.get(roomName);

    if (!room) {
      return {
        status: "fail",
        failMessage: `Room "${roomName}" doesn't exist.`,
      };
    }

    for (const member of room) {
      const memberConnection = this.connections.get(member);

      if (!memberConnection) {
        throw new Error("Member connection not found in the connections list.");
      }

      if (memberConnection.username === username) {
        return {
          status: "fail",
          failMessage: `Username "${username}" is already taken by someone else in this room.`,
        };
      }
    }

    connection.room = roomName;
    connection.username = username;

    socket.join(roomName);
    this.emitRoomStateChange(roomName);

    this.log.info(`Connection ${username}: joined room ${roomName}`);

    return {
      status: "ok",
    };
  }

  /**
   * Method that gets triggered on "toggleReady" event.
   *
   * @param socket The socket that triggered the event.
   * @param roomName The room that the event got triggered for.
   * @returns The event result.
   */
  private onToggleReady(
    connection: Connection,
    roomName: string
  ): EventResult<undefined> {
    connection.isReady = !connection.isReady;
    this.entireRoomReadyCheck(roomName);
    this.emitRoomStateChange(roomName);

    this.log.info(
      `Connection ${roomName}/${connection.username}: toggled state`
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
    const roomName = connection?.room;

    // todo: theres a bug in here when user leaves before joining a room

    if (!connection || !roomName) {
      return;
    }

    socket.leave(roomName);

    this.connections.delete(socket.id);

    this.log.info(`Connection ${roomName}/${connection.username}: left`);

    if (!roomExists(this.io, roomName)) {
      return;
    }

    // Delete room and disconnect all users if host.
    if (connection.isHost) {
      for (const member of getRoomMembers(this.io, roomName).values()) {
        member.disconnect();
      }

      this.log.info(`Room ${roomName}: deleted`);
    }

    // Emit a state change event if not host.
    if (!connection.isHost) {
      this.entireRoomReadyCheck(roomName);
      this.emitRoomStateChange(roomName);
    }
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
   * @param roomName The room to emit the update to.
   */
  private emitRoomStateChange(roomName: string): void {
    const connections = getRoomConnections(this.io, this.connections, roomName);
    const state = connections.map((roomConnection) => ({
      username: roomConnection.username,
      isReady: roomConnection.isReady,
      isHost: roomConnection.isHost,
    }));

    this.io.in(roomName).emit("roomStateChange", state);

    this.log.info(`Room ${roomName}: state changed`, state);
  }

  /**
   * Checks if the entire room is ready. If it is, resets the ready state of
   * everyone in the room and emits a "roomReady" event to the host.
   *
   * @param room The room to check.
   */
  private entireRoomReadyCheck(roomName: string): void {
    if (!roomExists(this.io, roomName)) {
      return;
    }

    const connections = getRoomConnections(this.io, this.connections, roomName);
    const everyoneIsReady = connections.reduce(
      (previousValue, currentValue) => previousValue && currentValue.isReady,
      connections[0].isReady
    );

    if (!everyoneIsReady) {
      return;
    }

    for (const roomConnection of connections) {
      roomConnection.isReady = false;
    }

    const host = connections.find((connection) => connection.isHost);

    if (!host) {
      return;
    }

    this.io.to(host.socket.id).emit("roomReady");

    this.log.info(`Room ${roomName}: emitted room ready to host`);
  }

  /**
   * Validates the room presence of a connection.
   *
   * @param connection The connection in question.
   * @param expected Expected presence. True for connection being present in a
   * room, and false for not.
   * @returns A boolean depending on whether the connection is in a room or
   * not.
   */
  private validateRoomPresence<T = undefined>(
    connection: Connection,
    expected: boolean
  ): EventResult<T> | null {
    const isInRoom = connection.room !== null;

    if (isInRoom === expected) {
      return null;
    }

    return {
      status: "fail",
      failMessage: expected
        ? "This user is not yet in a room."
        : "This user is already in a room.",
    };
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
    } while (roomExists(this.io, roomName));

    return roomName;
  }
}
