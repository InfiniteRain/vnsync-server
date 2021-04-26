import { io, Socket } from "socket.io-client";
import { VNSyncServer } from "./VNSyncServer";
import { EventResult } from "./interfaces/EventResult";
import { cloneDeep } from "lodash";
import { getLogger } from "loglevel";
import { VNSyncSocket } from "./interfaces/VNSyncSocket";

describe("vnsync server", () => {
  let wsServer: VNSyncServer;
  let wsClients: Socket[] = [];
  let user: Socket;

  const log = getLogger("vnsync-tests");
  const connectionString = "ws://localhost:8080";

  log.setLevel("silent");

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

  const getNewWsClient = async (): Promise<Socket> => {
    const newClient = io(connectionString);
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

  const findUsernameInClients = (
    username: string,
    map: Map<string, VNSyncSocket>
  ): VNSyncSocket => {
    const client = [...map].filter(
      ([_, client]) => client.username === username
    )[0][1];

    if (!client) {
      throw new Error(`username "${username}" was not found`);
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

    expect(result.status).toEqual("ok");

    return newUser;
  };

  const createRoom = async (socket: Socket): Promise<string> => {
    const result = await promiseEmit<EventResult<string>>(
      socket,
      "createRoom",
      "user"
    );

    expect(result.status).toEqual("ok");

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
    wsServer = new VNSyncServer(log);
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

      expect(result.status).toEqual("fail");
      expect(result.failMessage).toEqual(
        "Username should be a non-empty string."
      );

      const result2 = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        ""
      );

      expect(result2.status).toEqual("fail");
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

      expect(result.status).toEqual("ok");
      expect(typeof result.data).toEqual("string");
      expect(result.data?.length).toBeGreaterThan(0);
      expect(result.failMessage).toBeUndefined();
      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const userSnapshot = findUsernameInClients(
        "user",
        wsServer.clientsSnapshot
      );

      expect(userSnapshot.username).toEqual("user");
    });

    test("user attempts to create room two times", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const result2 = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      expect(result2.status).toEqual("fail");
      expect(result2.failMessage).toEqual("This user is already in a room.");
      expect(result2.data).toBeUndefined();
    });

    test("user attempts to join a room when hosting", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const result2 = await promiseEmit<EventResult<undefined>>(
        user,
        "joinRoom",
        "user",
        "someNonExistentRoom"
      );

      expect(result2.status).toEqual("fail");
      expect(result2.failMessage).toEqual("This user is already in a room.");
      expect(result2.data).toBeUndefined();
    });

    test("user attempts to join a room with bad params", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const newUser = await getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom"
      );

      expect(result2.status).toEqual("fail");
      expect(result2.failMessage).toEqual(
        "Username should be a non-empty string."
      );

      const result3 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        ""
      );

      expect(result3.status).toEqual("fail");
      expect(result3.failMessage).toEqual(
        "Username should be a non-empty string."
      );

      const result4 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "room"
      );

      expect(result4.status).toEqual("fail");
      expect(result4.failMessage).toEqual(
        "Room name should be a non-empty string."
      );

      const result5 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "room",
        ""
      );

      expect(result5.status).toEqual("fail");
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

      expect(result.status).toEqual("fail");
      expect(result.failMessage).toEqual(`Room "${roomName}" doesn't exist.`);
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

      expect(result.status).toEqual("ok");
      expect(wsServer.roomsSnapshot.size).toEqual(2);
      expect(wsServer.clientsSnapshot.size).toEqual(1);

      const userSnapshot = findUsernameInClients(
        "user",
        wsServer.clientsSnapshot
      );

      expect(userSnapshot.username).toEqual("user");

      const newUser = await getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user2",
        result.data
      );

      expect(result2.status).toEqual("ok");
      expect(wsServer.roomsSnapshot.size).toEqual(3);
      expect(wsServer.clientsSnapshot.size).toEqual(2);

      const user2Snapshot = findUsernameInClients(
        "user2",
        wsServer.clientsSnapshot
      );

      expect(user2Snapshot.username).toEqual("user2");
    });

    test("user attempts to join a room with a username that's already taken", async () => {
      const result = await promiseEmit<EventResult<string>>(
        user,
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const newUser = await getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user",
        result.data
      );

      expect(result2.status).toEqual("fail");
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

      expect(result.status).toEqual("ok");
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

      expect(result.status).toEqual("ok");
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

      expect(result.status).toEqual("fail");
      expect(result.failMessage).toEqual("This user is not yet in a room.");
      expect(result.data).toBeUndefined();
    });

    test("users receive state updates once they create or join a room", async () => {
      const expectedRoomState = [
        { username: "user", isHost: true, isReady: false },
      ];

      const [advanceEventCounter, counterOf] = generateEventCounter(3);
      const waitFor1st = counterOf(1);
      const waitFor3rd = counterOf(3);

      user.on("roomStateChange", (state) => {
        expect(state).toEqual(expectedRoomState);
        advanceEventCounter();
      });

      const roomName = await createRoom(user);
      await waitFor1st;

      expectedRoomState.push({
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

      expect(result.status).toEqual("ok");

      await waitFor3rd;
    });

    test("users receive a state update once another user from the same room leaves", async () => {
      const roomName = await createRoom(user);
      const user2 = await addNewUserToARoom("user2", roomName);
      const user3 = await addNewUserToARoom("user3", roomName);

      const [advanceEventCounter, counterOf] = generateEventCounter(2);
      const waitFor2nd = counterOf(2);

      const expectedRoomState = [
        { username: "user", isHost: true, isReady: false },
        { username: "user3", isHost: false, isReady: false },
      ];

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

      const expectedRoomState = [
        { username: "user", isHost: true, isReady: true },
        { username: "user2", isHost: false, isReady: false },
        { username: "user3", isHost: false, isReady: false },
      ];

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
      expect(result.status).toEqual("ok");

      await waitFor3rd;

      expectedRoomState[2].isReady = true;
      const result2 = await emitToggleReady(user3);
      expect(result2.status).toEqual("ok");

      await waitFor6th;

      expectedRoomState[0].isReady = false;
      const result3 = await emitToggleReady(user);
      expect(result3.status).toEqual("ok");

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

      const expectedRoomState = [
        { username: "user", isHost: true, isReady: true },
        { username: "user2", isHost: false, isReady: false },
        { username: "user3", isHost: false, isReady: false },
      ];

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

      expectedRoomState[1].isReady = true;
      await emitToggleReady(user2);
      await waitFor6th;

      expectedRoomState[0].isReady = false;
      expectedRoomState[1].isReady = false;
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

      const expectedRoomState = [
        { username: "user", isHost: true, isReady: true },
        { username: "user2", isHost: false, isReady: false },
        { username: "user3", isHost: false, isReady: false },
      ];

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

      expectedRoomState[2].isReady = true;
      await emitToggleReady(user3);
      await waitFor4th;

      expectedRoomState.splice(1, 1);
      expectedRoomState[0].isReady = false;
      expectedRoomState[1].isReady = false;
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

      const expectedRoomState = [
        { username: "user", isHost: true, isReady: false },
      ];

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
  });

  describe("connection limit tests", () => {
    test("addresses map gets updated properly", async () => {
      expect(wsServer.addressesSnapshot.size).toEqual(1);

      const roomName = await createRoom(user);

      expect(wsServer.addressesSnapshot.size).toEqual(1);

      const address = findUsernameInClients("user", wsServer.clientsSnapshot)
        .handshake.address;

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

      const address = findUsernameInClients("user", wsServer.clientsSnapshot)
        .handshake.address;

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
});
