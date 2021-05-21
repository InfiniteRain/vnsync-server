import express from "express";
import path from "path";
import { createServer, Server as HTTPServer } from "http";
import { Server } from "socket.io";
import { cloneDeep } from "lodash";
import { Logger } from "loglevel";
import { Configuration } from "./interfaces/Configuration";
import {
  nonEmptyString,
  string,
  validateEventArguments,
  validateRoomPresence,
  ValidationRule,
} from "./eventValidator";
import {
  getAllClients,
  getClientBySessionId,
  getRoomMembers,
  roomExists,
} from "./helpers";
import { VNSyncSocket } from "./interfaces/VNSyncSocket";
import { VNSyncData } from "./interfaces/VNSyncData";
import { GhostSession } from "./interfaces/GhostSession";
import { v4 as uuidv4 } from "uuid";
import { EventResult } from "./interfaces/EventResult";
import { Socket } from "socket.io";
import { ExtendedError } from "socket.io/dist/namespace";

/**
 * Default configuration.
 */
const defaultConfiguration: Configuration = {
  maxConnectionsFromSingleSource: Number.parseInt(
    process.env.MAX_CONNECTIONS_FROM_SINGLE_SOURCE || "5"
  ),

  maxClipboardEntries: Number.parseInt(
    process.env.MAX_CLIPBOARD_ENTRIES || "50"
  ),

  ghostSessionLifetime: Number.parseInt(
    process.env.GHOST_SESSION_LIFETIME || "30000"
  ),

  ghostSessionCleanupInterval: Number.parseInt(
    process.env.GHOST_SESSION_CLEANUP_INTERVAL || "1000"
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
   * This map represents the amount of connections made from a single ip
   * address.
   */
  private readonly addresses: Map<string, number> = new Map();

  /**
   * This map represents current ghost sessions.
   */
  private readonly ghostSessions: Map<string, GhostSession> = new Map();

  /**
   * The session cleanup interval.
   */
  private readonly sessionCleanupInterval: NodeJS.Timeout;

  /**
   * A resolve function for a disconnect promise.
   * Used only for tests.
   */
  private disconnectResolve: (() => void) | null = null;

  /**
   * If set to true, then the next disconnection will count as unexpected
   * regardless of the disconnection reason.
   * Used only for tests.
   */
  private isNextDisconnectUnexpected = false;

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

    this.sessionCleanupInterval = setInterval(() => {
      this.cleanGhostSessions();
    }, this.configuration.ghostSessionCleanupInterval);

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

    clearInterval(this.sessionCleanupInterval);
  }

  /**
   * Gets a snapshot of currently connected clients, deeply cloned.
   * Used only for tests.
   */
  public get clientsSnapshot(): Map<string, VNSyncSocket> {
    return cloneDeep(getAllClients(this.io));
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
   * Gets a snapshot of current ghost sessions, deeply cloned.
   * Used only for tests.
   */
  public get ghostSessionsSnapshot(): Map<string, GhostSession> {
    return cloneDeep(this.ghostSessions);
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
   * Calling this function will make it so that the next disconnection will be
   * counted as unexpected, regardless of the disconnection reason.
   * Used only for tests.
   */
  public countNextDisconnectAsUnexpected(): void {
    if (this.isNextDisconnectUnexpected) {
      throw new Error("Already waiting for a disonnection.");
    }

    this.isNextDisconnectUnexpected = true;
  }

  /**
   * Cleans expired ghost sessions.
   */
  public cleanGhostSessions(): void {
    for (const [sessionId, ghostSession] of this.ghostSessions.entries()) {
      const threshold =
        ghostSession.leftAt + this.configuration.ghostSessionLifetime;
      if (Date.now() >= threshold) {
        this.log.info(`Ghost session ${sessionId}: cleaned.`);

        this.handleRoomDisconnect(ghostSession.data);
        this.ghostSessions.delete(sessionId);
      }
    }
  }

  /**
   * Middleware that checks connection limit.
   *
   * @param socket The socket in question.
   * @param next Next middleware function.
   */
  private connectionLimitMiddleware(
    socket: Socket,
    next: (err?: ExtendedError | undefined) => void
  ): void {
    if (this.isAddressBlocked(socket.handshake.address)) {
      next(new Error("Too many connections from the same address."));
      return;
    }

    next();
  }

  /**
   * Middleware that handles reconnection logic.
   *
   * @param socket The socket in question.
   * @param next Next middleware function.
   */
  private reconnectionMiddleare(
    socket: Socket,
    next: (err?: ExtendedError | undefined) => void
  ): void {
    const sessionId = socket.handshake.auth.sessionId;

    if (!sessionId) {
      next();
      return;
    }

    this.log.info(`Connection with sessionId: ${sessionId}`);

    const ghostSession = this.ghostSessions.get(sessionId);

    if (ghostSession) {
      this.ghostSessions.delete(sessionId);

      this.log.info(`Ghost session found: ${sessionId}`);

      if (!roomExists(this.io, ghostSession.data.room || "")) {
        next(new Error("The room for this session no longer exists."));
        return;
      }

      socket.data = ghostSession.data;

      next();
      return;
    }

    const existingUser = getClientBySessionId(this.io, sessionId);

    if (existingUser) {
      socket.data = existingUser.data;

      this.log.info(`Matching connection found: ${sessionId}`);

      existingUser.disconnect();
    }

    next();
  }

  /**
   * Registers a socket event by validating event data and attaching it to the
   * appropriate method.
   *
   * @param socket The socket for which to register the event.
   * @param eventName The name of the event.
   * @param eventMethod The method of the event.
   * @param argumentsValidation Validation rules for event data.
   * @param requirePresence Expected room presence. True for the client being
   * present in a room, and false for not.
   */
  private registerEvent<T = void>(
    socket: Socket,
    eventName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventMethod: (socket: Socket, ...args: any[]) => EventResult<T>,
    argumentsValidation: ValidationRule[],
    requirePresence: boolean
  ) {
    socket.on(eventName, (...args: unknown[]) => {
      const callback = args.pop() as (result: EventResult<T>) => void;
      const validationError =
        validateEventArguments<T>(argumentsValidation, args) ||
        validateRoomPresence<T>(socket, requirePresence);

      if (validationError) {
        callback(validationError);
        return;
      }

      const result = eventMethod.bind(this)(socket, ...args);

      this.log.info(`Event ${eventName} emitted by ${socket.id}:`, result);

      callback(result);
    });
  }

  /**
   * Initializes the WebSocket server.
   */
  private initServer(): void {
    this.log.info("Initializing the server...");

    this.io
      .use((socket, next) => this.connectionLimitMiddleware(socket, next))
      .use((socket, next) => this.reconnectionMiddleare(socket, next))
      .on("connection", (connectionSocket) => {
        const socket = connectionSocket as VNSyncSocket;

        this.log.info(`Socket ${socket.id}: connecting...`);
        this.log.info(
          `Socket auth ${socket.id}: ${JSON.stringify(socket.handshake.auth)}`
        );

        this.addAddress(socket.handshake.address);

        this.registerEvent<string>(
          socket,
          "createRoom",
          this.onCreateRoom,
          [nonEmptyString("Username")],
          false
        );
        this.registerEvent(
          socket,
          "joinRoom",
          this.onJoinRoom,
          [nonEmptyString("Username"), nonEmptyString("Room name")],
          false
        );
        this.registerEvent(socket, "toggleReady", this.onToggleReady, [], true);
        this.registerEvent(
          socket,
          "updateClipboard",
          this.onUpdateClipboard,
          [string("Clipboard entry")],
          true
        );

        socket.on("disconnect", (reason) => {
          this.log.info(`Socket ${socket.id}: disconnected`);

          this.onDisconnect(socket, reason);
          this.removeAddress(socket.handshake.address);

          if (this.disconnectResolve !== null) {
            this.disconnectResolve();
            this.disconnectResolve = null;
          }
        });

        this.onConnect(socket);
      });
  }

  /**
   * Method that gets triggered when a socket connects.
   *
   * @param socket The socket that triggered the event.
   */
  private onConnect(socket: VNSyncSocket): void {
    const roomName = socket.data.room;

    if (roomName && !roomExists(this.io, roomName) && !socket.data.isHost) {
      socket.disconnect();

      return;
    }

    if (roomName) {
      socket.join(roomName);
      this.emitRoomStateChange(roomName);

      this.log.info(
        `Connection ${roomName}/${socket.data.username}: reconnected`
      );

      return;
    }

    const sessionId = uuidv4();

    socket.data = {
      sessionId,
      username: "",
      isHost: false,
      room: null,
      isReady: false,
      clipboard: [],
    };

    socket.emit("sessionId", sessionId);
  }

  /**
   * Method that gets triggered on "createRoom" event.
   *
   * @param socket The socket that triggered the event.
   * @param username The username.
   * @returns The event result.
   */
  private onCreateRoom(
    socket: VNSyncSocket,
    username: string
  ): EventResult<string> {
    const roomName = this.generateRoomName();

    socket.data.username = username;
    socket.data.room = roomName;
    socket.data.isHost = true;
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
   * @param username The username.
   * @param roomName The room name.
   * @returns The event result.
   */
  private onJoinRoom(
    socket: VNSyncSocket,
    username: string,
    roomName: string
  ): EventResult {
    if (!roomExists(this.io, roomName)) {
      return {
        status: "fail",
        failMessage: `Room "${roomName}" doesn't exist.`,
      };
    }

    for (const member of getRoomMembers(this.io, roomName)) {
      if (member.data.username === username) {
        return {
          status: "fail",
          failMessage: `Username "${username}" is already taken by someone else in this room.`,
        };
      }
    }

    socket.data.room = roomName;
    socket.data.username = username;
    socket.join(roomName);

    this.emitRoomStateChange(roomName);

    this.log.info(`Connection ${username}: joined room ${roomName}`);

    return {
      status: "ok",
      data: undefined,
    };
  }

  /**
   * Method that gets triggered on "toggleReady" event.
   *
   * @param socket The socket that triggered the event.
   * @returns The event result.
   */
  private onToggleReady(socket: VNSyncSocket): EventResult {
    const roomName = socket.data.room || "";

    socket.data.isReady = !socket.data.isReady;

    this.entireRoomReadyCheck(roomName);
    this.emitRoomStateChange(roomName);

    this.log.info(
      `Connection ${roomName}/${socket.data.username}: toggled state`
    );

    return {
      status: "ok",
      data: undefined,
    };
  }

  /**
   * Method that gets triggered on "updateClipboard" event.
   *
   * @param socket The socket that triggered the event.
   * @param clipboardEntry The clipboard entry.
   * @returns The event result.
   */
  private onUpdateClipboard(
    socket: VNSyncSocket,
    clipboardEntry: string
  ): EventResult {
    if (!socket.data.isHost) {
      return {
        status: "fail",
        failMessage: "This user is not a host.",
      };
    }

    const roomName = socket.data.room || "";

    socket.data.clipboard.unshift(clipboardEntry);
    socket.data.clipboard = socket.data.clipboard.slice(
      0,
      this.configuration.maxClipboardEntries
    );

    this.emitRoomStateChange(roomName);

    return {
      status: "ok",
      data: undefined,
    };
  }

  /**
   * Method that gets triggered on "disconnect" event.
   *
   * @param socket The socket that triggered the event.
   * @param reason Reason for disconnection.
   */
  private onDisconnect(socket: VNSyncSocket, reason: string): void {
    const badReasons = ["ping timeout", "transport close", "transport error"];

    if (badReasons.includes(reason) || this.isNextDisconnectUnexpected) {
      this.isNextDisconnectUnexpected = false;

      this.ghostSessions.set(socket.data.sessionId, {
        leftAt: Date.now(),
        data: socket.data,
      });

      const handle = socket.data.room
        ? `Connection ${socket.data.room}/${socket.data.username}`
        : `Socket ${socket.id}`;
      this.log.info(
        `${handle}: disconnected with a bad reason, keeping a ghost session...`
      );

      return;
    }

    this.handleRoomDisconnect(socket.data);
  }

  /**
   * Handles the room state on client disconnection.
   *
   * @param data Data of the socket.
   */
  private handleRoomDisconnect(data: VNSyncData): void {
    const roomName = data?.room;

    if (!roomName || !roomExists(this.io, roomName)) {
      return;
    }

    this.log.info(`Connection ${roomName}/${data.username}: left`);

    if (data.isHost) {
      this.io.in(roomName).disconnectSockets();

      this.log.info(`Room ${roomName}: deleted`);

      return;
    }

    this.entireRoomReadyCheck(roomName);
    this.emitRoomStateChange(roomName);
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
    const members = getRoomMembers(this.io, roomName);

    const host = members.find((member) => member.data.isHost);
    const membersState = members.map((member) => ({
      username: member.data.username,
      isReady: member.data.isReady,
      isHost: member.data.isHost,
    }));

    const state = {
      clipboard: host?.data?.clipboard || [],
      membersState,
    };

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

    const members = getRoomMembers(this.io, roomName);
    const everyoneIsReady = members.reduce(
      (previousValue, currentValue) =>
        previousValue && currentValue.data.isReady,
      members[0].data.isReady
    );

    if (!everyoneIsReady) {
      return;
    }

    for (const member of members) {
      member.data.isReady = false;
    }

    const host = members.find((member) => member.data.isHost);

    if (!host) {
      return;
    }

    this.io.to(host.id).emit("roomReady");

    this.log.info(`Room ${roomName}: emitted event roomReady to host`);
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
