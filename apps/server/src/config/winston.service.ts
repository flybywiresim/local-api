import { Injectable } from '@nestjs/common';
import { getSimbridgeDir } from 'apps/server/src/utilities/pathUtil';
import {
  WinstonModuleOptions,
  WinstonModuleOptionsFactory,
  utilities as nestWinstonModuleUtilities,
} from 'nest-winston';
import { join } from 'path';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

const consoleTransport = new winston.transports.Console({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize({ message: true }),
    winston.format.timestamp(),
    winston.format.ms(),
    nestWinstonModuleUtilities.format.nestLike('FBW-SimBridge', { prettyPrint: true }),
    winston.format.errors({ stack: true }),
  ),
});

const fileTransport = new winston.transports.DailyRotateFile({
  frequency: '24h',
  filename: 'fbw-simbridge-%DATE%.log',
  dirname: `${join(getSimbridgeDir(), 'resources/logs')}`,
  datePattern: 'YYYY-MM-DD-HH',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  level: 'debug',
});

const defaultFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.ms(),
  nestWinstonModuleUtilities.format.nestLike('FBW-SimBridge', { prettyPrint: true }),
  winston.format.errors({ stack: true }),
  winston.format.uncolorize(),
);

@Injectable()
export class WinstonConfigService implements WinstonModuleOptionsFactory {
  createWinstonModuleOptions(): WinstonModuleOptions {
    return {
      levels: {
        error: 0,
        warn: 1,
        info: 2,
        debug: 3,
        verbose: 4,
      },
      format: defaultFormat,
      transports: [consoleTransport, fileTransport],
    };
  }
}
