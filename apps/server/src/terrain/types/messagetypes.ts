export enum MainToWorkerThreadMessageTypes {
  Unknown = '',
  Shutdown = 'REQ_SHUTDOWN',
  FrameData = 'REQ_FRAME_DATA',
  AircraftStatusData = 'AIRCRAFT_STATUS_DATA',
  VerticalDisplayPath = 'VD_PATH',
}

export enum WorkerToMainThreadMessageTypes {
  Unknown = '',
  FrameData = 'RES_FRAME_DATA',
  LogInfo = 'LOGINFO',
  LogWarn = 'LOGWARN',
  LogError = 'LOGERROR',
}
