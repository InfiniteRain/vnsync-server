# VNSync Server

This project is a WebSocket server for VNSync.

## Setup

To setup the project:

```
git clone https://github.com/InfiniteRain/vnsync-server.git
cd vnsync-server
npm install
```

To run the tests:

```
npm test
```

To build the project:

```
npm run build
```

To launch the server:

```
npm start
# or if you want to build and then run:
npm run buildStart
```

## Environment variables

The server expects the following environment variables:

- `PORT` - The port to serve on (default is 8080).
- `MAX_CONNECTIONS_FROM_SINGLE_SOURCE` - The limit of connections per address (default is 5).
- `MAX_CLIPBOARD_ENTRIES` - Maximum clipboard capacity (default is 50).
- `GHOST_SESSION_LIFETIME` - Maximum amount of time (ms) that a ghost session is allowed to exist (default is 30000).
- `GHOST_SESSION_CLEANUP_INTERVAL` - Interval (ms) at which ghost session cleanup happens (default is 1000).
