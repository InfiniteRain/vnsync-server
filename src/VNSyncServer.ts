import express from "express";
import path from "path";
import { createServer, Server as HTTPServer } from "http";
import { Server } from "socket.io";
import { EventResult } from "./interfaces/EventResult";
import { cloneDeep } from "lodash";
import { Logger } from "loglevel";
import { Configuration } from "./interfaces/Configuration";
import {
  nonEmptyString,
  string,
  validateEventArguments,
  validateRoomPresence,
} from "./eventValidator";
import { getAllClients, getRoomMembers, roomExists } from "./helpers";
import { VNSyncSocket } from "./interfaces/VNSyncSocket";

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
      .on("connection", (connectionSocket) => {
        const socket = connectionSocket as VNSyncSocket;

        this.log.info(`Socket ${socket.id}: connecting...`);

        socket.username = "";
        socket.isHost = false;
        socket.room = null;
        socket.isReady = false;
        socket.clipboard = [];

        this.addAddress(socket.handshake.address);

        socket.on("createRoom", (...args: unknown[]) => {
          const callback = args.pop() as (result: EventResult<string>) => void;
          const username = args[0] as string;
          const validationError =
            validateEventArguments<string>(
              [nonEmptyString("Username")],
              [username]
            ) || validateRoomPresence<string>(socket, false);

          if (validationError) {
            callback(validationError);
            return;
          }

          const result = this.onCreateRoom(socket, username);

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
            ) || validateRoomPresence(socket, false);

          if (validationError) {
            callback(validationError);
            return;
          }

          const result = this.onJoinRoom(socket, username, roomName);

          this.log.info(`Event joinRoom emitted by ${socket.id}:`, result);

          callback(result);
        });

        socket.on("toggleReady", (...args: unknown[]) => {
          const callback = args.pop() as (
            result: EventResult<undefined>
          ) => void;
          const validationError = validateRoomPresence(socket, true);

          if (validationError) {
            callback(validationError);
            return;
          }

          const result = this.onToggleReady(socket, socket.room || "");

          this.log.info(`Event toggleReady emitted by ${socket.id}:`, result);

          callback(result);
        });

        socket.on("updateClipboard", (...args: unknown[]) => {
          const callback = args.pop() as (
            result: EventResult<undefined>
          ) => void;
          const clipboardEntry = args[0] as string;
          const validationError =
            validateEventArguments(
              [string("Clipboard entry")],
              [clipboardEntry]
            ) || validateRoomPresence(socket, true);

          if (validationError) {
            callback(validationError);
            return;
          }

          const result = this.onUpdateClipboard(
            socket,
            clipboardEntry,
            socket.room || ""
          );

          this.log.info(
            `Event updateClipboard emitted by ${socket.id}:`,
            result
          );

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
   * @param username The username.
   * @returns The event result.
   */
  private onCreateRoom(
    socket: VNSyncSocket,
    username: string
  ): EventResult<string> {
    const roomName = this.generateRoomName();

    socket.username = username;
    socket.room = roomName;
    socket.isHost = true;
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
  ): EventResult<undefined> {
    if (!roomExists(this.io, roomName)) {
      return {
        status: "fail",
        failMessage: `Room "${roomName}" doesn't exist.`,
      };
    }

    for (const member of getRoomMembers(this.io, roomName)) {
      if (member.username === username) {
        return {
          status: "fail",
          failMessage: `Username "${username}" is already taken by someone else in this room.`,
        };
      }
    }

    socket.room = roomName;
    socket.username = username;
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
    socket: VNSyncSocket,
    roomName: string
  ): EventResult<undefined> {
    socket.isReady = !socket.isReady;

    this.entireRoomReadyCheck(roomName);
    this.emitRoomStateChange(roomName);

    this.log.info(`Connection ${roomName}/${socket.username}: toggled state`);

    return {
      status: "ok",
    };
  }

  /**
   * Method that gets triggered on "updateClipboard" event.
   *
   * @param socket The socket that triggered the event.
   * @param clipboardEntry The clipboard entry.
   * @param roomName The room that the event got triggered for.
   * @returns The event result.
   */
  private onUpdateClipboard(
    socket: VNSyncSocket,
    clipboardEntry: string,
    roomName: string
  ): EventResult<undefined> {
    if (!socket.isHost) {
      return {
        status: "fail",
        failMessage: "This user is not a host.",
      };
    }

    socket.clipboard.unshift(clipboardEntry);
    socket.clipboard = socket.clipboard.slice(
      0,
      this.configuration.maxClipboardEntries
    );

    this.emitRoomStateChange(roomName);

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
  private onDisconnect(socket: VNSyncSocket): void {
    const roomName = socket.room;

    if (!roomName || !roomExists(this.io, roomName)) {
      return;
    }

    socket.leave(roomName);

    this.log.info(`Connection ${roomName}/${socket.username}: left`);

    // Delete room and disconnect all users if host.
    if (socket.isHost) {
      this.io.in(roomName).disconnectSockets();

      this.log.info(`Room ${roomName}: deleted`);

      return;
    }

    // Emit a state change event if not host.
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

    const host = members.find((member) => member.isHost);
    const membersState = members.map((member) => ({
      username: member.username,
      isReady: member.isReady,
      isHost: member.isHost,
    }));

    const state = {
      clipboard: host?.clipboard || [],
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
      (previousValue, currentValue) => previousValue && currentValue.isReady,
      members[0].isReady
    );

    if (!everyoneIsReady) {
      return;
    }

    for (const member of members) {
      member.isReady = false;
    }

    const host = members.find((member) => member.isHost);

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
