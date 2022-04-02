import { Injectable, Logger } from '@nestjs/common';
import { FileService } from '../utilities/file.service';
import { Terrainmap } from './mapformat/terrainmap';
import { Worldmap } from './manager/worldmap';
import { Configuration } from './dto/configuration.dto';

@Injectable()
export class TerrainService {
    private readonly logger = new Logger(TerrainService.name);

    private terrainDirectory = 'resources/terrain/';

    public Terrainmap: Terrainmap | undefined = undefined;

    public MapManager: Worldmap | undefined = undefined;

    constructor(private fileService: FileService) {
        this.readTerrainmap().then((map) => {
            this.Terrainmap = map;
            if (map !== undefined) {
                this.MapManager = new Worldmap(this.Terrainmap);
            }
        });
    }

    async readTerrainmap(): Promise<Terrainmap | undefined> {
        try {
            const buffer = await this.fileService.getFile(
                this.terrainDirectory,
                'terrain.map',
            );
            this.logger.log(`Read MB of terrainmap: ${Buffer.byteLength(buffer) / (1024 * 1024)}`);

            return new Terrainmap(buffer);
        } catch (err) {
            this.logger.warn('Did not find the terrain.map-file');
            return undefined;
        }
    }

    terrainmapExists(): boolean {
        return this.Terrainmap !== undefined;
    }

    public configure(config: Configuration): void {
        this.MapManager.configure(config);
    }

}
