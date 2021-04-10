import { Socket } from "socket.io";

export interface Connection {
  username: string;
  isHost: boolean;
  room: string;
  socket: Socket;
}
