import {
  ClientDataArea,
  ClientDataOffsetAuto,
  ClientDataMaxSize,
  Connection,
  ErrorMessage,
  ExceptionMessage,
  OpenMessage,
  Receiver,
  ClientDataRequestMessage,
  ClientDataPeriod,
  ClientDataRequest,
  SystemEvent,
  SystemEventType,
  SystemEventMessage,
  SystemEventSim,
  SystemEventPause,
  SystemEventPauseType,
} from '@flybywiresim/msfs-nodejs';
import { Logger } from '../processing/logging/logger';
import { NavigationDisplayData, AircraftStatus, PositionData, TerrainRenderingMode } from '../types';

export type UpdateCallbacks = {
  reset: () => void;
  paused: () => void;
  unpaused: () => void;
  positionUpdate: (data: PositionData) => void;
  aircraftStatusUpdate: (data: AircraftStatus) => void;
};

const SimConnectClientName = 'FBW_SIMBRIDGE_SIMCONNECT';

const enum ClientDataId {
  EnhancedGpwcAircraftStatus = 0,
  NavigationDisplayMetdataLeft = 1,
  NavigationDisplayMetdataRight = 2,
  NavigationDisplayFrameLeft = 3,
  NavigationDisplayFrameRight = 4,
}

const enum DataDefinitionId {
  EnhancedGpwcAircraftStatus = 0,
  NavigationDisplayMetadataAreaLeft = 1,
  NavigationDisplayMetadataAreaRight = 2,
  NavigationDisplayFrameAreaLeft = 3,
  NavigationDisplayFrameAreaRight = 4,
}

const enum SystemEventId {
  SimulatorState = 0,
  PauseState = 1,
}

const EnhancedGpwcAircraftStatusByteCount = 46;
const NavigationDisplayThresholdByteCount = 14;

export class SimConnect {
  private callbacks: UpdateCallbacks = {
    reset: null,
    paused: null,
    unpaused: null,
    positionUpdate: null,
    aircraftStatusUpdate: null,
  };

  private shutdown: boolean = false;

  private showConnectionError: boolean = true;

  private connection: Connection = null;

  private receiver: Receiver = null;

  private egpwcAircraftStatus: ClientDataArea = null;

  private frameMetadataLeft: ClientDataArea = null;

  private frameMetadataRight: ClientDataArea = null;

  private frameDataLeft: ClientDataArea = null;

  private frameDataRight: ClientDataArea = null;

  private simulatorStateEvent: SystemEvent = null;

  private pauseStateEvent: SystemEvent = null;

  private registerSystemEvents(): boolean {
    this.simulatorStateEvent = new SystemEvent(this.connection, SystemEventId.SimulatorState, SystemEventType.Sim);
    this.pauseStateEvent = new SystemEvent(this.connection, SystemEventId.PauseState, SystemEventType.PauseEX1);
    return true;
  }

  private registerEgpwcAircraftStatus(): boolean {
    this.egpwcAircraftStatus = new ClientDataArea(this.connection, ClientDataId.EnhancedGpwcAircraftStatus);
    if (!this.egpwcAircraftStatus.mapNameToId('FBW_SIMBRIDGE_EGPWC_AIRCRAFT_STATUS')) {
      this.logging.error(`Unable to map aircraft status: ${this.egpwcAircraftStatus.lastError()}`);
      return false;
    }

    const addedDefinition = this.egpwcAircraftStatus.addDataDefinition({
      definitionId: DataDefinitionId.EnhancedGpwcAircraftStatus,
      offset: ClientDataOffsetAuto,
      sizeOrType: EnhancedGpwcAircraftStatusByteCount,
      epsilon: 0,
      memberName: 'AircraftStatus',
    });
    if (!addedDefinition) {
      this.logging.error(`Unable to define aircraft status data: ${this.egpwcAircraftStatus.lastError()}`);
    }

    return addedDefinition;
  }

  private registerNavigationDisplayMetadata(
    clientId: ClientDataId,
    mapName: string,
    dataDefinitionId: DataDefinitionId,
  ): ClientDataArea {
    const metadata = new ClientDataArea(this.connection, clientId);
    if (!metadata.mapNameToId(mapName)) {
      this.logging.error(`Unable to map data for ${mapName}: ${metadata.lastError()}`);
    }

    const addedDefinition = metadata.addDataDefinition({
      definitionId: dataDefinitionId,
      offset: ClientDataOffsetAuto,
      sizeOrType: NavigationDisplayThresholdByteCount,
      epsilon: 0.0,
      memberName: 'ThresholdData',
    });
    if (addedDefinition === false) {
      this.logging.error(`Unable to create the data definitions for ${mapName}: ${this.connection.lastError()}`);
      return null;
    }

    if (!metadata.allocateArea(NavigationDisplayThresholdByteCount, true)) {
      this.logging.error(
        `Unable to create the threshold client data area for ${mapName}: ${this.connection.lastError()}`,
      );
      return null;
    }

    return metadata;
  }

  private registerNavigationDisplayData(): boolean {
    this.frameDataLeft = new ClientDataArea(this.connection, ClientDataId.NavigationDisplayFrameLeft);
    if (!this.frameDataLeft.mapNameToId('FBW_SIMBRIDGE_TERRONND_FRAME_DATA_LEFT')) {
      this.logging.error(
        `Unable to map data for FBW_SIMBRIDGE_TERRONND_FRAME_DATA_LEFT: ${this.frameDataLeft.lastError()}`,
      );
      return false;
    }

    let addedDefinition = this.frameDataLeft.addDataDefinition({
      definitionId: DataDefinitionId.NavigationDisplayFrameAreaLeft,
      offset: ClientDataOffsetAuto,
      sizeOrType: ClientDataMaxSize,
      epsilon: 0,
      memberName: 'FrameData',
    });
    if (!addedDefinition) {
      this.logging.error(
        `Unable to add data definition for FBW_SIMBRIDGE_TERRONND_FRAME_DATA_LEFT: ${this.frameDataLeft.lastError()}`,
      );
      return false;
    }

    if (!this.frameDataLeft.allocateArea(ClientDataMaxSize, true)) {
      this.logging.error(
        `Unable to allocate data for FBW_SIMBRIDGE_TERRONND_FRAME_DATA_LEFT: ${this.frameDataLeft.lastError()}`,
      );
      return false;
    }

    this.frameDataRight = new ClientDataArea(this.connection, ClientDataId.NavigationDisplayFrameRight);
    if (!this.frameDataRight.mapNameToId('FBW_SIMBRIDGE_TERRONND_FRAME_DATA_RIGHT')) {
      this.logging.error(
        `Unable to map data for FBW_SIMBRIDGE_TERRONND_FRAME_DATA_RIGHT: ${this.frameDataRight.lastError()}`,
      );
      return false;
    }

    addedDefinition = this.frameDataRight.addDataDefinition({
      definitionId: DataDefinitionId.NavigationDisplayFrameAreaRight,
      offset: ClientDataOffsetAuto,
      sizeOrType: ClientDataMaxSize,
      epsilon: 0,
      memberName: 'FrameData',
    });
    if (!addedDefinition) {
      this.logging.error(
        `Unable to add data definition for FBW_SIMBRIDGE_TERRONND_FRAME_DATA_RIGHT: ${this.frameDataRight.lastError()}`,
      );
      return false;
    }

    if (!this.frameDataRight.allocateArea(ClientDataMaxSize, true)) {
      this.logging.error(
        `Unable to allocate data for FBW_SIMBRIDGE_TERRONND_FRAME_DATA_RIGHT: ${this.frameDataRight.lastError()}`,
      );
      return false;
    }

    return true;
  }

  private simConnectOpen(logon: OpenMessage): void {
    if (this.receiver !== null) {
      let resetConnection = false;

      if (
        !this.receiver.requestClientData(this.egpwcAircraftStatus, ClientDataPeriod.OnSet, ClientDataRequest.Default)
      ) {
        this.logging.error('Unable to request aircraft status data');
        resetConnection = true;
      }
      if (!this.receiver.subscribeSystemEvent(this.simulatorStateEvent)) {
        this.logging.error('Unable to subscribe to the simulator states');
        resetConnection = true;
      }
      if (!this.receiver.subscribeSystemEvent(this.pauseStateEvent)) {
        this.logging.error('Unable to subscribe to the pause states');
        resetConnection = true;
      }

      if (resetConnection === true) {
        this.simConnectQuit();
        return;
      }
    }

    this.logging.info(
      `Connected to MSFS - ${logon.application.name} - v${logon.application.version.major}.${logon.application.version.minor}`,
    );
    this.showConnectionError = true;
  }

  private resetConnection(): void {
    this.receiver.stop();
    this.receiver = null;
    this.frameMetadataLeft = null;
    this.frameMetadataRight = null;
    this.frameDataLeft = null;
    this.frameDataRight = null;
    this.simulatorStateEvent = null;
    this.pauseStateEvent = null;
    this.connection.close();
  }

  private simConnectQuit(): void {
    if (this.callbacks.reset !== null) {
      this.callbacks.reset();
    }

    this.resetConnection();
    this.logging.info('Received a quit signal. Trying to reconnect...');

    this.connectToSim();
  }

  private simConnectError(message: ErrorMessage): void {
    if (message !== null) {
      this.logging.error(`Error: ${message.id}`);
    } else {
      this.logging.error('Invalid error');
    }
  }

  private simConnectException(_message: ExceptionMessage): void {
    this.resetConnection();
    setTimeout(() => this.connectToSim(), 10000);
  }

  private simConnectReceivedClientData(message: ClientDataRequestMessage): void {
    if (message.clientDataId === ClientDataId.EnhancedGpwcAircraftStatus) {
      const entry = Object.entries(message.content)[0];
      const data = entry[1] as ArrayBuffer;
      const buffer = Buffer.from(data);

      if (this.callbacks.positionUpdate !== null) {
        const positionData: PositionData = {
          latitude: buffer.readFloatLE(38),
          longitude: buffer.readFloatLE(42),
        };

        this.callbacks.positionUpdate(positionData);
      }

      if (this.callbacks.aircraftStatusUpdate !== null) {
        const lat = buffer.readFloatLE(1);
        const lon = buffer.readFloatLE(5);
        const terrEnabledCapt = buffer.readUInt8(30) !== 0;
        const terrEnabledFO = buffer.readUInt8(35) !== 0;
        const heading = buffer.readInt16LE(13);
        const status: AircraftStatus = {
          adiruDataValid: buffer.readUInt8(0) !== 0,
          tawsInop: false,
          latitude: lat,
          longitude: lon,
          altitude: buffer.readInt32LE(9),
          heading: heading,
          verticalSpeed: buffer.readInt16LE(15),
          gearIsDown: buffer.readUInt8(17) !== 0,
          runwayDataValid: buffer.readUInt8(18) !== 0,
          runwayLatitude: buffer.readFloatLE(19),
          runwayLongitude: buffer.readFloatLE(23),
          efisDataCapt: {
            ndRange: buffer.readUInt16LE(27),
            arcMode: buffer.readUInt8(29) !== 0,
            terrOnNd: terrEnabledCapt,
            terrOnVd: terrEnabledCapt,
            efisMode: buffer.readUInt8(31),
            vdRangeLower: -500,
            vdRangeUpper: 24000,
          },
          efisDataFO: {
            ndRange: buffer.readUInt16LE(32),
            arcMode: buffer.readUInt8(34) !== 0,
            terrOnNd: terrEnabledFO,
            terrOnVd: terrEnabledFO,
            efisMode: buffer.readUInt8(36),
            vdRangeLower: -500,
            vdRangeUpper: 24500,
          },
          navigationDisplayRenderingMode: buffer.readUInt8(37) as TerrainRenderingMode,
          manualAzimEnabled: true,
          manualAzimDegrees: heading,
          groundTruthLatitude: lat,
          groundTruthLongitude: lon,
        };

        this.callbacks.aircraftStatusUpdate(status);
      }
    }
  }

  private simConnectSystemEvent(message: SystemEventMessage): void {
    if (message.eventId === SystemEventId.SimulatorState) {
      const sim = message.content as SystemEventSim;
      if (sim.running === false && this.callbacks.reset !== null) {
        this.callbacks.reset();
      }
    } else if (message.eventId === SystemEventId.PauseState) {
      const pause = message.content as SystemEventPause;
      if (pause.type !== SystemEventPauseType.Unpaused) {
        if (this.callbacks.paused !== null) this.callbacks.paused();
      } else if (this.callbacks.unpaused !== null) this.callbacks.unpaused();
    } else {
      this.logging.error(`Unknown system event ID: ${message.eventId}`);
    }
  }

  private connectToSim() {
    if (this.shutdown) return;

    this.connection = new Connection();
    if (this.connection.open(SimConnectClientName) === false) {
      if (this.showConnectionError === true) {
        this.logging.error(`Connection to MSFS failed: ${this.connection.lastError()} - Retry every 10 seconds`);
      }
      setTimeout(() => this.connectToSim(), 10000);
      this.showConnectionError = false;
      return;
    }

    if (this.receiver !== null) this.receiver.stop();
    this.receiver = new Receiver(this.connection);
    this.receiver.addCallback('open', (message: OpenMessage) => this.simConnectOpen(message));
    this.receiver.addCallback('quit', () => this.simConnectQuit());
    this.receiver.addCallback('clientData', (message: ClientDataRequestMessage) =>
      this.simConnectReceivedClientData(message),
    );
    this.receiver.addCallback('systemEvent', (message: SystemEventMessage) => this.simConnectSystemEvent(message));
    this.receiver.addCallback('exception', (message: ExceptionMessage) => this.simConnectException(message));
    this.receiver.addCallback('error', (message: ErrorMessage) => this.simConnectError(message));
    this.receiver.start();

    if (!this.registerEgpwcAircraftStatus()) {
      setTimeout(() => this.resetConnection(), 10000);
      return;
    }

    this.frameMetadataLeft = this.registerNavigationDisplayMetadata(
      ClientDataId.NavigationDisplayMetdataLeft,
      'FBW_SIMBRIDGE_TERRONND_THRESHOLDS_LEFT',
      DataDefinitionId.NavigationDisplayMetadataAreaLeft,
    );
    if (this.frameMetadataLeft === null) {
      setTimeout(() => this.connectToSim(), 10000);
      return;
    }

    this.frameMetadataRight = this.registerNavigationDisplayMetadata(
      ClientDataId.NavigationDisplayMetdataRight,
      'FBW_SIMBRIDGE_TERRONND_THRESHOLDS_RIGHT',
      DataDefinitionId.NavigationDisplayMetadataAreaRight,
    );
    if (this.frameMetadataRight === null) {
      setTimeout(() => this.connectToSim(), 10000);
      return;
    }

    if (!this.registerNavigationDisplayData() || !this.registerSystemEvents()) {
      this.receiver.stop();
      this.connection.close();
      setTimeout(() => this.connectToSim(), 10000);
    }
  }

  constructor(private logging: Logger) {
    this.connectToSim();
  }

  public terminate(): void {
    if (this.receiver !== null) this.receiver.stop();
    if (this.connection !== null) this.connection.close();
  }

  public sendNavigationDisplayTerrainMapMetadata(side: string, metadata: NavigationDisplayData): void {
    if (this.connection === null || !this.connection.isConnected()) return;

    const packed = Buffer.alloc(NavigationDisplayThresholdByteCount);
    packed.writeInt16LE(metadata.MinimumElevation, 0);
    packed.writeUInt8(metadata.MinimumElevationMode, 2);
    packed.writeInt16LE(metadata.MaximumElevation, 3);
    packed.writeUInt8(metadata.MaximumElevationMode, 5);
    packed.writeUInt8(metadata.FirstFrame ? 1 : 0, 6);
    packed.writeUInt16LE(Math.round(metadata.DisplayRange), 7);
    packed.writeUInt8(metadata.DisplayMode, 9);
    packed.writeUInt32LE(metadata.FrameByteCount, 10);

    let resetConnection = false;
    if (side === 'L') {
      if (this.frameMetadataLeft.setData({ ThresholdData: packed.buffer }) === false) {
        this.logging.error(`Could not send metadata: ${this.frameMetadataLeft.lastError()}`);
        resetConnection = true;
      }
    } else if (this.frameMetadataRight.setData({ ThresholdData: packed.buffer }) === false) {
      this.logging.error(`Could not send metadata: ${this.frameMetadataRight.lastError()}`);
      resetConnection = true;
    }

    if (resetConnection === true) {
      this.logging.error('Resetting connection to MSFS due to transmission error');
      this.simConnectQuit();
    }
  }

  public sendNavigationDisplayTerrainMapFrame(side: string, frame: Buffer): void {
    if (this.connection === null || !this.connection.isConnected()) return;

    // calculate the size
    const chunks = Math.ceil(frame.byteLength / ClientDataMaxSize);
    const stream = Buffer.alloc(ClientDataMaxSize);

    for (let i = 0; i < chunks; ++i) {
      // copy over the remaining data
      const remaining = frame.byteLength - i * ClientDataMaxSize;
      const byteCount = remaining >= ClientDataMaxSize ? ClientDataMaxSize : remaining;
      frame.copy(stream, 0, i * ClientDataMaxSize, i * ClientDataMaxSize + byteCount);

      // send the data
      let resetConnection = false;
      if (side === 'L') {
        if (this.frameDataLeft.setData({ FrameData: stream.buffer }) === false) {
          this.logging.error(`Could not send frame data: ${this.frameDataLeft.lastError()}`);
          resetConnection = true;
        }
      } else if (this.frameDataRight.setData({ FrameData: stream.buffer }) === false) {
        this.logging.error(`Could not send frame data: ${this.frameDataRight.lastError()}`);
        resetConnection = true;
      }

      if (resetConnection === true) {
        this.logging.error('Resetting connection to MSFS due to transmission error');
        this.simConnectQuit();
        break;
      }
    }
  }

  public addUpdateCallback<K extends keyof UpdateCallbacks>(event: K, callback: UpdateCallbacks[K]): void {
    this.callbacks[event] = callback;
  }
}
