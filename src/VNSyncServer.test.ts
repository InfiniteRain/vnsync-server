import { io, Socket } from "socket.io-client";
import { VNSyncServer } from "./VNSyncServer";
import { cloneDeep } from "lodash";
import { getLogger } from "loglevel";
import { VNSyncSocket } from "./interfaces/VNSyncSocket";
import { EventFailedResult } from "./interfaces/EventFailResult";
import { EventSuccessResult } from "./interfaces/EventSuccessResult";
import { EventResult } from "./interfaces/EventResult";

describe("vnsync server", () => {
  type RoomState = {
    clipboard: string[];
    membersState: {
      username: string;
      isHost: boolean;
      isReady: boolean;
    }[];
  };

  let wsServer: VNSyncServer;
  let wsClients: Socket[] = [];
  let user: Socket;

  const log = getLogger("vnsync-tests");
  const connectionString = "ws://localhost:8080";

  log.setLevel("silent");

  function assertSuccessResult<T>(
    eventResult: EventResult<T>
  ): asserts eventResult is EventSuccessResult<T> {
    if (eventResult.status !== "ok") {
      throw new Error("Result is not a success.");
    }
  }

  function assertFailResult<T>(
    eventResult: EventResult<T>
  ): asserts eventResult is EventFailedResult {
    if (eventResult.status !== "fail") {
      throw new Error("Result is not a failure.");
    }
  }

  const promiseEmit = <T>(
    socket: Socket,
    eventName: string,
    ...args: unknown[]
  ): Promise<T> => {
    return new Promise<T>((resolve) => {
      socket.emit(eventName, ...args, (data: T) => {
        resolve(data);
      });
    });
  };

  const getNewWsClient = async (sessionId?: string): Promise<Socket> => {
    const newClient = io(
      connectionString,
      sessionId ? { auth: { sessionId } } : undefined
    );
    return new Promise((resolve) => {
      newClient.on("connect", () => {
        wsClients.push(newClient);
        resolve(newClient);
      });
    });
  };

  const closeWsSocket = (index: number): void => {
    if (wsClients[index] === undefined) {
      throw new Error(`wsClient with index ${index} doesn't exist`);
    }

    wsClients[index].close();
    wsClients.splice(index, 1);
  };

  const findInClients = (
    value: string,
    map: Map<string, VNSyncSocket>,
    mode: "username" | "sid" = "username"
  ): VNSyncSocket => {
    const client = [...map].filter(([sid, client]) => {
      if (mode === "username") {
        return client.data.username === value;
      }

      return sid === value;
    })[0][1];

    if (!client) {
      throw new Error(`${mode} "${value}" was not found`);
    }

    return client;
  };

  const addNewUserToARoom = async (
    username?: string,
    roomName?: string
  ): Promise<Socket> => {
    if (username === undefined || roomName === undefined) {
      throw new Error(
        `malformed data passed: username="${username}"; roomName="${roomName}"`
      );
    }

    const newUser = await getNewWsClient();
    const result = await promiseEmit<EventResult<undefined>>(
      newUser,
      "joinRoom",
      username,
      roomName
    );

    assertSuccessResult(result);

    return newUser;
  };

  const createRoom = async (socket: Socket): Promise<string> => {
    const result = await promiseEmit<EventResult<string>>(
      socket,
      "createRoom",
      "user"
    );

    assertSuccessResult(result);

    if (result.data === undefined) {
      throw new Error("room name is undefined");
    }

    return result.data;
  };

  const emitToggleReady = async (
    socket: Socket
  ): Promise<EventResult<void>> => {
    return await promiseEmit<EventResult<void>>(socket, "toggleReady");
  };

  const emitUpdateClipboard = async (
    socket: Socket,
    entry: string
  ): Promise<EventResult<void>> => {
    return await promiseEmit<EventResult<void>>(
      socket,
      "updateClipboard",
      entry
    );
  };

  const generateEventCounter = (
    limit: number
  ): [() => void, (count: number) => Promise<void>] => {
    let counter = 0;
    const counterResolveFunctions = new Map<number, (value: void) => void>();

    const counterOf = (count: number): Promise<void> => {
      if (counterResolveFunctions.has(count)) {
        throw new Error("promise for this count has already been generated");
      }

      return new Promise<void>((resolve) => {
        counterResolveFunctions.set(count, resolve);
      });
    };

    const advanceEventCounter = () => {
      counter++;

      if (counter > limit) {
        throw new Error("event counter broke the limit");
      }

      const counterResolve = counterResolveFunctions.get(counter);

      if (counterResolve) {
        counterResolve();
      }
    };

    return [advanceEventCounter, counterOf];
  };

  beforeEach(async () => {
    wsServer = new VNSyncServer(log, {
      maxConnectionsFromSingleSource: 5,
      maxClipboardEntries: 50,
      ghostSessionLifetime: 0,
      ghostSessionCleanupInterval: 99999999,
    });
    wsServer.start(8080);
    user = await getNewWsClient();
  });

  afterEach(() => {
    for (const client of wsClients) {
      client.close();
    }

    wsClients = [];
    wsServer.close();
  });

  describe("room tests", () => {
    test("user attempts to create a room with no username provided", async () => {
      const result = await promiseEmit<EventResult<string>>(user, "createRoom");

      assertFailResult(result);
      expect(result.failMessage).toEqual(
        "Username should be a non-empty string."
      );

      const result2 = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        ""
      );

      assertFailResult(result2);
      expect(result2.failMessage).toEqual(
        "Username should be a non-empty string."
      );
    });

    test("user creates a room", async () => {
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertSuccessResult(result);
      expect(typeof result.data).toEqual("string");
      expect(result.data?.length).toBeGreaterThan(0);
      // @ts-expect-error Type mismatch is expected in here.
      expect(result.failMessage).toBeUndefined();
      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const userSnapshot = findInClients("user", wsServer.clientsSnapshot);

      expect(userSnapshot.data.username).toEqual("user");
    });

    test("user attempts to create room two times", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertSuccessResult(result);

      const result2 = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertFailResult(result2);
      expect(result2.failMessage).toEqual("This user is already in a room.");
      // @ts-expect-error Type mismatch is expected in here.
      expect(result2.data).toBeUndefined();
    });

    test("user attempts to join a room when hosting", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertSuccessResult(result);

      const result2 = await promiseEmit<EventResult<undefined>>(
        user,
        "joinRoom",
        "user",
        "someNonExistentRoom"
      );

      assertFailResult(result2);
      expect(result2.failMessage).toEqual("This user is already in a room.");
      // @ts-expect-error Type mismatch is expected in here.
      expect(result2.data).toBeUndefined();
    });

    test("user attempts to join a room with bad params", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertSuccessResult(result);

      const newUser = await getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom"
      );

      assertFailResult(result2);
      expect(result2.failMessage).toEqual(
        "Username should be a non-empty string."
      );

      const result3 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        ""
      );

      assertFailResult(result3);
      expect(result3.failMessage).toEqual(
        "Username should be a non-empty string."
      );

      const result4 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "room"
      );

      assertFailResult(result4);
      expect(result4.failMessage).toEqual(
        "Room name should be a non-empty string."
      );

      const result5 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "room",
        ""
      );

      assertFailResult(result5);
      expect(result5.failMessage).toEqual(
        "Room name should be a non-empty string."
      );
    });

    test("user attempts to join a non-existent room", async () => {
      const roomName = "someNonExistentRoom";
      const result = await promiseEmit<EventResult<string>>(
        user,
        "joinRoom",
        "user",
        roomName
      );

      assertFailResult(result);
      expect(result.failMessage).toEqual(`Room "${roomName}" doesn't exist.`);
      // @ts-expect-error Type mismatch is expected in here.
      expect(result.data).toBeUndefined();
    });

    test("user joins a room", async () => {
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertSuccessResult(result);
      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const userSnapshot = findInClients("user", wsServer.clientsSnapshot);

      expect(userSnapshot.data.username).toEqual("user");

      const newUser = await getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user2",
        result.data
      );

      assertSuccessResult(result2);
      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);

      const user2Snapshot = findInClients("user2", wsServer.clientsSnapshot);

      expect(user2Snapshot.data.username).toEqual("user2");
    });

    test("user attempts to join a room with a username that's already taken", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertSuccessResult(result);

      const newUser = await getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user",
        result.data
      );

      assertFailResult(result2);
      expect(result2.failMessage).toEqual(
        'Username "user" is already taken by someone else in this room.'
      );
    });

    test("room gets deleted when the host leaves", async () => {
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      await promiseEmit<EventResult<string>>(user, "createRoom", "user");

      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      closeWsSocket(0);
      await wsServer.awaitForDisconnect();

      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.clientsSnapshot.size).toEqual(0);
    });

    test("room doesn't get deleted when a non-host user leaves", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertSuccessResult(result);
      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      await addNewUserToARoom("user2", result.data);

      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);

      closeWsSocket(1);
      await wsServer.awaitForDisconnect();

      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);
    });

    test("room users get disconnected when the host leaves", async () => {
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      assertSuccessResult(result);
      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      await addNewUserToARoom("user2", result.data);

      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);

      closeWsSocket(0);
      await wsServer.awaitForDisconnect();

      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.clientsSnapshot.size).toEqual(0);
    });
  });

  describe("ready logic tests", () => {
    test("user attempts to toggle the ready state while not in a room", async () => {
      const result = await emitToggleReady(user);

      assertFailResult(result);
      expect(result.failMessage).toEqual("This user is not yet in a room.");
      // @ts-expect-error Type mismatch is expected in here.
      expect(result.data).toBeUndefined();
    });

    test("users receive state updates once they create or join a room", async () => {
      const expectedRoomState = {
        clipboard: [],
        membersState: [{ username: "user", isHost: true, isReady: false }],
      };

      const [advanceEventCounter, counterOf] = generateEventCounter(3);
      const waitFor1st = counterOf(1);
      const waitFor3rd = counterOf(3);

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(expectedRoomState);
        advanceEventCounter();
      });

      const roomName = await createRoom(user);
      await waitFor1st;

      expectedRoomState.membersState.push({
        username: "user2",
        isHost: false,
        isReady: false,
      });

      const newUser = await getNewWsClient();
      newUser.on("roomStateChange", (state) => {
        expect(state).toEqual(expectedRoomState);
        advanceEventCounter();
      });

      const result = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user2",
        roomName
      );

      assertSuccessResult(result);

      await waitFor3rd;
    });

    test("users receive a state update once another user from the same room leaves", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);
      const user3 = await addNewUserToARoom("user3", roomName);

      const [advanceEventCounter, counterOf] = generateEventCounter(2);
      const waitFor2nd = counterOf(2);

      const expectedRoomState = {
        clipboard: [],
        membersState: [
          { username: "user", isHost: true, isReady: false },
          { username: "user3", isHost: false, isReady: false },
        ],
      };

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      user3.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      user2.disconnect();
      await wsServer.awaitForDisconnect();
      await waitFor2nd;
    });

    test("users can toggle ready status and everyone receives a state update", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);
      const user3 = await addNewUserToARoom("user3", roomName);

      const [advanceEventCounter, counterOf] = generateEventCounter(9);
      const waitFor3rd = counterOf(3);
      const waitFor6th = counterOf(6);
      const waitFor9th = counterOf(9);

      const expectedRoomState = {
        clipboard: [],
        membersState: [
          { username: "user", isHost: true, isReady: true },
          { username: "user2", isHost: false, isReady: false },
          { username: "user3", isHost: false, isReady: false },
        ],
      };

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      user2.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      user3.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      const result = await emitToggleReady(user);
      assertSuccessResult(result);

      await waitFor3rd;

      expectedRoomState.membersState[2].isReady = true;
      const result2 = await emitToggleReady(user3);
      assertSuccessResult(result2);

      await waitFor6th;

      expectedRoomState.membersState[0].isReady = false;
      const result3 = await emitToggleReady(user);
      assertSuccessResult(result3);

      await waitFor9th;
    });

    test("ready status resets once everyone is ready and an event is emited to host", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);
      const user3 = await addNewUserToARoom("user3", roomName);

      const [advanceEventCounter, counterOf] = generateEventCounter(9);
      const waitFor3rd = counterOf(3);
      const waitFor6th = counterOf(6);
      const waitFor9th = counterOf(9);

      const [advanceReadyEventCounter, counterOfReady] = generateEventCounter(
        1
      );
      const waitFor1stReady = counterOfReady(1);

      const expectedRoomState = {
        clipboard: [],
        membersState: [
          { username: "user", isHost: true, isReady: true },
          { username: "user2", isHost: false, isReady: false },
          { username: "user3", isHost: false, isReady: false },
        ],
      };

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      user.on("roomReady", () => {
        advanceReadyEventCounter();
      });

      user2.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      user3.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      await emitToggleReady(user);
      await waitFor3rd;

      expectedRoomState.membersState[1].isReady = true;
      await emitToggleReady(user2);
      await waitFor6th;

      expectedRoomState.membersState[0].isReady = false;
      expectedRoomState.membersState[1].isReady = false;
      await emitToggleReady(user3);
      await waitFor9th;
      await waitFor1stReady;
    });

    test("ready status resets once the only user that is in a non-ready status disconnects", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);
      const user3 = await addNewUserToARoom("user3", roomName);

      const [advanceEventCounter, counterOf] = generateEventCounter(6);
      const waitFor2nd = counterOf(2);
      const waitFor4th = counterOf(4);
      const waitFor6th = counterOf(6);

      const [advanceReadyEventCounter, counterOfReady] = generateEventCounter(
        1
      );
      const waitFor1stReady = counterOfReady(1);

      const expectedRoomState = {
        clipboard: [],
        membersState: [
          { username: "user", isHost: true, isReady: true },
          { username: "user2", isHost: false, isReady: false },
          { username: "user3", isHost: false, isReady: false },
        ],
      };

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      user.on("roomReady", () => {
        advanceReadyEventCounter();
      });

      user3.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      await emitToggleReady(user);
      await waitFor2nd;

      expectedRoomState.membersState[2].isReady = true;
      await emitToggleReady(user3);
      await waitFor4th;

      expectedRoomState.membersState.splice(1, 1);
      expectedRoomState.membersState[0].isReady = false;
      expectedRoomState.membersState[1].isReady = false;
      user2.disconnect();
      await wsServer.awaitForDisconnect();
      await waitFor6th;
      await waitFor1stReady;
    });

    test("ready status resets properly when the host is alone", async () => {
      await createRoom(user);

      const [advanceEventCounter, counterOf] = generateEventCounter(2);
      const waitFor1st = counterOf(1);
      const waitFor2nd = counterOf(2);

      const [advanceReadyEventCounter, counterOfReady] = generateEventCounter(
        2
      );
      const waitFor1stReady = counterOfReady(1);
      const waitFor2ndReady = counterOfReady(2);

      const expectedRoomState = {
        clipboard: [],
        membersState: [{ username: "user", isHost: true, isReady: false }],
      };

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceEventCounter();
      });

      user.on("roomReady", () => {
        advanceReadyEventCounter();
      });

      await emitToggleReady(user);
      await waitFor1st;
      await waitFor1stReady;

      await emitToggleReady(user);
      await waitFor2nd;
      await waitFor2ndReady;
    });

    test("host attempts to update clipboard while not in a room", async () => {
      const result = await emitUpdateClipboard(user, "something");

      assertFailResult(result);
      expect(result.failMessage).toEqual("This user is not yet in a room.");
      // @ts-expect-error Type mismatch is expected in here.
      expect(result.data).toBeUndefined();
    });

    test("host attempts to update clipboard with bad argument", async () => {
      await createRoom(user);
      // @ts-expect-error Type mismatch is expected in here.
      const result = await emitUpdateClipboard(user, undefined);

      assertFailResult(result);
      expect(result.failMessage).toEqual("Clipboard entry should be a string.");
      // @ts-expect-error Type mismatch is expected in here.
      expect(result.data).toBeUndefined();
    });

    test("user attempts to update clipboard as a non-host", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);

      const result = await emitUpdateClipboard(user2, "something");

      assertFailResult(result);
      expect(result.failMessage).toEqual("This user is not a host.");
      // @ts-expect-error Type mismatch is expected in here.
      expect(result.data).toBeUndefined();
    });

    test("host updates clipboard", async () => {
      await createRoom(user);

      const [
        advanceClipboardCounter,
        counterOfClipboard,
      ] = generateEventCounter(2);

      const expectedRoomState: RoomState = {
        clipboard: [],
        membersState: [{ username: "user", isHost: true, isReady: false }],
      };
      const waitFor1st = counterOfClipboard(1);
      const waitFor2nd = counterOfClipboard(2);

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceClipboardCounter();
      });

      expectedRoomState.clipboard.unshift("text1");

      const result = await emitUpdateClipboard(user, "text1");
      assertSuccessResult(result);
      await waitFor1st;

      expectedRoomState.clipboard.unshift("text2");

      const result2 = await emitUpdateClipboard(user, "text2");
      assertSuccessResult(result2);
      await waitFor2nd;
    });

    test("host posts one entry over the limit", async () => {
      await createRoom(user);

      const [
        advanceClipboardCounter,
        counterOfClipboard,
      ] = generateEventCounter(51);

      const expectedRoomState: RoomState = {
        clipboard: [],
        membersState: [{ username: "user", isHost: true, isReady: false }],
      };

      const range = [...new Array(51).keys()];
      const waitFors = range.map((value) => counterOfClipboard(value + 1));

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(cloneDeep(expectedRoomState));
        advanceClipboardCounter();
      });

      for (const index of range) {
        const clipboardEntry = `text${index}`;

        expectedRoomState.clipboard.unshift(clipboardEntry);
        expectedRoomState.clipboard = expectedRoomState.clipboard.slice(0, 50);

        const result = await emitUpdateClipboard(user, clipboardEntry);
        assertSuccessResult(result);
        await waitFors[index];
      }
    });
  });

  describe("connection limit tests", () => {
    test("addresses map gets updated properly", async () => {
      expect(wsServer.addressesSnapshot.size).toEqual(1);

      const roomName = await createRoom(user);

      expect(wsServer.addressesSnapshot.size).toEqual(1);

      const address = findInClients("user", wsServer.clientsSnapshot).handshake
        .address;

      expect(wsServer.addressesSnapshot.get(address)).toEqual(1);

      const user2 = await addNewUserToARoom("user2", roomName);

      expect(wsServer.addressesSnapshot.get(address)).toEqual(2);

      const user3 = await addNewUserToARoom("user3", roomName);

      expect(wsServer.addressesSnapshot.get(address)).toEqual(3);

      user2.disconnect();
      await wsServer.awaitForDisconnect();
      user3.disconnect();
      await wsServer.awaitForDisconnect();

      expect(wsServer.addressesSnapshot.get(address)).toEqual(1);

      user.disconnect();
      await wsServer.awaitForDisconnect();

      expect(wsServer.addressesSnapshot.size).toEqual(0);
    });

    test("address connection limit works properly", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);
      await addNewUserToARoom("user3", roomName);
      await addNewUserToARoom("user4", roomName);
      await addNewUserToARoom("user5", roomName);

      expect(wsServer.addressesSnapshot.size).toEqual(1);

      const address = findInClients("user", wsServer.clientsSnapshot).handshake
        .address;

      expect(wsServer.addressesSnapshot.get(address)).toEqual(5);

      const [advanceEventCounter, counterOf] = generateEventCounter(1);
      const waitFor1st = counterOf(1);

      const socket = io(connectionString, {
        reconnection: false,
      });
      socket.on("connect_error", (error: Error) => {
        expect(error.message).toEqual(
          "Too many connections from the same address."
        );

        advanceEventCounter();

        socket.close();
      });

      await waitFor1st;

      user2.disconnect();
      await wsServer.awaitForDisconnect();

      expect(wsServer.addressesSnapshot.get(address)).toEqual(4);

      await addNewUserToARoom("user6", roomName);

      expect(wsServer.addressesSnapshot.get(address)).toEqual(5);

      user.disconnect();
      await wsServer.awaitForDisconnect();

      expect(wsServer.addressesSnapshot.size).toEqual(0);
    });
  });

  describe("reconnection logic", () => {
    test("session cleanup works", async () => {
      await createRoom(user);
      const sessionId = findInClients("user", wsServer.clientsSnapshot).data
        .sessionId;

      expect(wsServer.ghostSessionsSnapshot.size).toEqual(0);

      wsServer.countNextDisconnectAsUnexpected();
      user.disconnect();
      await wsServer.awaitForDisconnect();

      expect(wsServer.ghostSessionsSnapshot.size).toEqual(1);
      expect(wsServer.ghostSessionsSnapshot.get(sessionId)).toBeDefined();

      wsServer.cleanGhostSessions();

      expect(wsServer.ghostSessionsSnapshot.size).toEqual(0);
    });

    test("room gets disposed of after cleanup", async () => {
      const roomName = await createRoom(user);
      await addNewUserToARoom("user2", roomName);

      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);

      wsServer.countNextDisconnectAsUnexpected();
      user.disconnect();
      await wsServer.awaitForDisconnect();

      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      wsServer.cleanGhostSessions();

      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.clientsSnapshot.size).toEqual(0);
    });

    test("user gets session id event on connect", async () => {
      const user2 = io(connectionString, {
        autoConnect: false,
      });

      const [advanceEventCounter, counterOf] = generateEventCounter(1);
      const waitFor1st = counterOf(1);

      user2.on("sessionId", (sessionId: string) => {
        advanceEventCounter();

        const originalSessionId = findInClients(
          user2.id,
          wsServer.clientsSnapshot,
          "sid"
        ).data.sessionId;

        expect(sessionId).toEqual(originalSessionId);
      });

      user2.connect();

      await waitFor1st;

      user2.disconnect();
      await wsServer.awaitForDisconnect();
    });

    test("user can reconnect", async () => {
      const roomName = await createRoom(user);
      const originalUserData = cloneDeep(
        findInClients("user", wsServer.clientsSnapshot).data
      );

      const user2 = await addNewUserToARoom("user2", roomName);

      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);

      const [advanceEventCounter, counterOf] = generateEventCounter(1);
      const waitFor1st = counterOf(1);

      user2.on("roomStateChange", () => {
        advanceEventCounter();
      });

      wsServer.countNextDisconnectAsUnexpected();
      user.disconnect();
      await wsServer.awaitForDisconnect();

      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);
      expect(
        wsServer.ghostSessionsSnapshot.get(originalUserData.sessionId)
      ).toBeDefined();

      const newClient = await getNewWsClient(originalUserData.sessionId);

      await waitFor1st;

      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);
      expect(wsServer.ghostSessionsSnapshot.size).toEqual(0);

      wsServer.cleanGhostSessions();

      expect(wsServer.roomsSnapshot.size).toEqual(3);

      const newUser = findInClients("user", wsServer.clientsSnapshot);

      expect(newUser.data).toEqual(originalUserData);
      expect(wsServer.roomsSnapshot.get(roomName)?.has(newUser.id)).toEqual(
        true
      );

      newClient.disconnect();
      await wsServer.awaitForDisconnect();
    });

    test("host can reconnect even when server still has the previous conenction going", async () => {
      await createRoom(user);
      const originalUserData = cloneDeep(
        findInClients("user", wsServer.clientsSnapshot).data
      );

      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const [advanceEventCounter, counterOf] = generateEventCounter(1);
      const waitFor1st = counterOf(1);

      user.on("disconnect", () => {
        advanceEventCounter();
      });

      const newUser = await getNewWsClient(originalUserData.sessionId);

      await waitFor1st;

      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const newUserData = findInClients("user", wsServer.clientsSnapshot).data;
      expect(newUserData).toEqual(originalUserData);

      newUser.disconnect();
      await wsServer.awaitForDisconnect();
    });

    test("user can reconnect even when server still has the previous conenction going", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);
      const originalUser2Data = cloneDeep(
        findInClients("user2", wsServer.clientsSnapshot).data
      );

      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);

      const [advanceEventCounter, counterOf] = generateEventCounter(1);
      const waitFor1st = counterOf(1);

      user2.on("disconnect", () => {
        advanceEventCounter();
      });

      const newUser2 = await getNewWsClient(originalUser2Data.sessionId);

      await waitFor1st;

      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);

      const newUser2Data = findInClients("user2", wsServer.clientsSnapshot)
        .data;
      expect(newUser2Data).toEqual(originalUser2Data);

      newUser2.disconnect();
      await wsServer.awaitForDisconnect();
      user.disconnect();
      await wsServer.awaitForDisconnect();
    });

    test("user can't reconnect with session id if the room has already been closed", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);
      const originalUser2Data = cloneDeep(
        findInClients("user2", wsServer.clientsSnapshot).data
      );

      wsServer.countNextDisconnectAsUnexpected();
      user2.disconnect();
      await wsServer.awaitForDisconnect();

      user.disconnect();
      await wsServer.awaitForDisconnect();

      const [advanceEventCounter, counterOf] = generateEventCounter(1);
      const waitFor1st = counterOf(1);

      const socket = io(connectionString, {
        reconnection: false,
        auth: {
          sessionId: originalUser2Data.sessionId,
        },
      });
      socket.on("connect_error", (error: Error) => {
        expect(error.message).toEqual(
          "The room for this session no longer exists."
        );

        advanceEventCounter();

        socket.close();
      });

      await waitFor1st;

      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.clientsSnapshot.size).toEqual(0);
      expect(wsServer.ghostSessionsSnapshot.size).toEqual(0);

      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
