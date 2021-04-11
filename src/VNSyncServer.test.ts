import { io, Socket } from "socket.io-client";
import { VNSyncServer } from "./VNSyncServer";
import { EventResult } from "./interfaces/EventResult";
import { Connection } from "./interfaces/Connection";

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

describe("vnsync server", () => {
  let wsServer: VNSyncServer;
  let wsClients: Socket[] = [];

  const getNewWsClient = (): Socket => {
    const newClient = io("ws://localhost:8080");
    wsClients.push(newClient);
    return newClient;
  };

  const closeWsSocket = (index: number): void => {
    if (wsClients[index] === undefined) {
      throw new Error(`wsClient with index ${index} doesn't exist`);
    }

    wsClients[index].close();
    wsClients.splice(index, 1);
  };

  const findUsernameInConnections = (
    username: string,
    map: Map<string, Connection>
  ): Connection => {
    const connection = [...map].filter(
      ([_, connection]) => connection.username === username
    )[0][1];

    if (!connection) {
      throw new Error(`username "${username}" was not found`);
    }

    return connection;
  };

  beforeEach(() => {
    wsServer = new VNSyncServer();
    wsServer.start(8080, true);
    getNewWsClient();
  });

  afterEach(() => {
    for (const client of wsClients) {
      client.close();
    }

    wsClients = [];
    wsServer.close();
  });

  test("user connects to the server", (done) => {
    wsClients[0].on("connect", () => {
      done();
    });
  });

  describe("room tests", () => {
    test("user attempts to create a room with no username provided", async () => {
      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom"
      );

      expect(result.status).toEqual("fail");
      expect(result.failMessage).toEqual(
        "Username should be a non-empty string."
      );

      const result2 = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        ""
      );

      expect(result2.status).toEqual("fail");
      expect(result2.failMessage).toEqual(
        "Username should be a non-empty string."
      );
    });

    test("user creates a room", async () => {
      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.connectionsSnapshot.size).toEqual(0);

      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");
      expect(typeof result.data).toEqual("string");
      expect(result.data?.length).toBeGreaterThan(0);
      expect(result.failMessage).toBeUndefined();
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(1);

      const userSnapshot = findUsernameInConnections(
        "user",
        wsServer.connectionsSnapshot
      );

      expect(userSnapshot.username).toEqual("user");
    });

    test("user attempts to create room two times", async () => {
      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const result2 = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result2.status).toEqual("fail");
      expect(result2.failMessage).toEqual("This user is already in a room.");
      expect(result2.data).toBeUndefined();
    });

    test("user attempts to join a room when hosting", async () => {
      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const result2 = await promiseEmit<EventResult<undefined>>(
        wsClients[0],
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
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const newUser = getNewWsClient();
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
        wsClients[0],
        "joinRoom",
        "user",
        roomName
      );

      expect(result.status).toEqual("fail");
      expect(result.failMessage).toEqual(`Room "${roomName}" doesn't exist.`);
      expect(result.data).toBeUndefined();
    });

    test("user joins a room", async () => {
      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.connectionsSnapshot.size).toEqual(0);

      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(1);

      const userSnapshot = findUsernameInConnections(
        "user",
        wsServer.connectionsSnapshot
      );

      expect(userSnapshot.username).toEqual("user");

      const newUser = getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user2",
        result.data
      );

      expect(result2.status).toEqual("ok");
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(2);

      const user2Snapshot = findUsernameInConnections(
        "user2",
        wsServer.connectionsSnapshot
      );

      expect(user2Snapshot.username).toEqual("user2");
    });

    test("user attempts to join a room with a username that's already taken", async () => {
      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const newUser = getNewWsClient();
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
      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.connectionsSnapshot.size).toEqual(0);

      await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(1);

      closeWsSocket(0);
      await wsServer.awaitForDisconnect();

      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.connectionsSnapshot.size).toEqual(0);
    });

    test("room doesn't get deleted when a non-host user leaves", async () => {
      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(1);

      const newUser = getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user2",
        result.data
      );

      expect(result2.status).toEqual("ok");
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(2);

      closeWsSocket(1);
      await wsServer.awaitForDisconnect();

      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(1);
    });

    test("room users get disconnected when the host leaves", async () => {
      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.connectionsSnapshot.size).toEqual(0);

      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(1);

      const newUser = getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user2",
        result.data
      );

      expect(result2.status).toEqual("ok");
      expect(wsServer.roomsSnapshot.size).toEqual(1);
      expect(wsServer.connectionsSnapshot.size).toEqual(2);

      closeWsSocket(0);
      await wsServer.awaitForDisconnect();

      expect(wsServer.roomsSnapshot.size).toEqual(0);
      expect(wsServer.connectionsSnapshot.size).toEqual(0);
    });

    test("room connections get updated properly", async () => {
      const result = await promiseEmit<EventResult<string>>(
        wsClients[0],
        "createRoom",
        "user"
      );

      expect(result.status).toEqual("ok");

      const roomName = result.data || "";
      const roomConnectionsSnaphot = wsServer.roomsSnapshot.get(roomName);

      expect(roomConnectionsSnaphot?.connections.length).toEqual(1);

      const newUser = getNewWsClient();
      const result2 = await promiseEmit<EventResult<undefined>>(
        newUser,
        "joinRoom",
        "user2",
        roomName
      );

      expect(result2.status).toEqual("ok");

      const roomConnectionsSnaphot2 = wsServer.roomsSnapshot.get(roomName);

      expect(roomConnectionsSnaphot2?.connections.length).toEqual(2);

      closeWsSocket(1);
      await wsServer.awaitForDisconnect();

      const roomConnectionsSnaphot3 = wsServer.roomsSnapshot.get(roomName);

      expect(roomConnectionsSnaphot3?.connections.length).toEqual(1);
      expect(roomConnectionsSnaphot3?.connections[0].username).toEqual("user");
    });
  });
});
