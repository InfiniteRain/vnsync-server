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
