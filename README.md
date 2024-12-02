![FlyByWire Simulations](https://raw.githubusercontent.com/flybywiresim/branding/1391fc003d8b5d439d01ad86e2778ae0bfc8b682/tails-with-text/FBW-Color-Light.svg#gh-dark-mode-only)
![FlyByWire Simulations](https://github.com/flybywiresim/branding/blob/master/tails-with-text/FBW-Color-Dark.svg#gh-light-mode-only)

[![Discord](https://img.shields.io/discord/738864299392630914.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/UjzuHMU)
[![Twitter](https://img.shields.io/badge/-@FlyByWireSim-e84393?label=&logo=twitter&logoColor=ffffff&color=6399AE&labelColor=00C2CB)](https://twitter.com/FlybywireSim)
[![YouTube](https://img.shields.io/badge/-FlyByWireSimulations-e84393?label=&logo=youtube&logoColor=ffffff&color=6399AE&labelColor=00C2CB)](https://www.youtube.com/c/FlyByWire-Simulations)
[![Facebook](https://img.shields.io/badge/-FlyByWireSimulations-e84393?label=&logo=facebook&logoColor=ffffff&color=6399AE&labelColor=00C2CB)](https://www.facebook.com/FlyByWireSimulations/)
[![Instagram](https://img.shields.io/badge/-@FlyByWireSim-e84393?label=&logo=instagram&logoColor=ffffff&color=6399AE&labelColor=00C2CB)](https://instagram.com/flybywiresim)

## FlyByWire SimBridge

This repo contains the source code to SimBridge

## Developing

Please make sure you have:

NodeJS 18 - [Homepage](https://nodejs.org/en/)

```bash
# Install all dependencies
$ npm install

# Build all packages
$ npm run build

# Start server; some steps required the first time, see below
$ npm run start

# Wipe build/ and dist/ folders, build all packages, package to exe and copy dependencies/resources to build folder
$ npm run build:exec

# Package to exe and copy dependencies/resources to build folder, without rebuilding
$ npm run install:exec

```

## First time running with npm

The server needs terrain data before it can run, so first do a full build:

```bash
$ npm run build:exec
```

This will build the terrain data in `build/terrain/`. This needs to be symlinked to the top level before running with npm:

```bash
mklink /J .\terrain .\build\terrain
```

## Documentation
Start the server and direct to `localhost:8380/api` for API documentation
