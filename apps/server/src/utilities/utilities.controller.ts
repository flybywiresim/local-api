import { Controller, Get, Query, StreamableFile, Response, ParseIntPipe } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { contentType } from 'mime-types';
import { FileService } from './file.service';

@ApiTags('UTILITIES')
@Controller('api/v1/utility')
export class UtilityController {
  constructor(private fileService: FileService) {}

  private readonly RES_PDF = 'resources/pdfs/';

  @Get('pdf')
  @ApiResponse({
    status: 200,
    description: 'A streamed converted png image',
    type: StreamableFile,
  })
  async getPdf(
    @Query('filename') filename: string,
    @Query('pagenumber', ParseIntPipe) pagenumber: number,
    @Response({ passthrough: true }) res,
    @Query('dirname') dirname?: string,
  ): Promise<StreamableFile> {
    if (undefined === dirname) {
      dirname = this.RES_PDF;
    } else {
      dirname = this.RES_PDF + dirname;
    }
    const convertedPdfFile = await this.fileService.getConvertedPdfFile(`${dirname}`, `${filename}`, pagenumber);

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename=out-${pagenumber}.png`,
    });

    return convertedPdfFile;
  }

  @Get('pdf/fromUrl')
  @ApiResponse({
    status: 200,
    description: 'A streamed converted png image',
    type: StreamableFile,
  })
  async getPdfFromUrl(
    @Query('encodedUrl') encodedUrl: string,
    @Query('pagenumber', ParseIntPipe) pagenumber: number,
    @Response({ passthrough: true }) res,
  ): Promise<StreamableFile> {
    const url = decodeURIComponent(encodedUrl);
    const convertedPdfFile = await this.fileService.getConvertedPdfFileFromUrl(`${url}`, pagenumber);

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename=out-${pagenumber}.png`,
    });

    return convertedPdfFile;
  }

  @Get('pdf/fromUrl/numpages')
  @ApiResponse({
    status: 200,
    description: 'Returns the number of pages in the pdf at the URL',
    type: Number,
  })
  async getNumberOfPagesFromUrl(@Query('encodedUrl') encodedUrl: string): Promise<number> {
    const url = decodeURIComponent(encodedUrl);
    return this.fileService.getNumberOfPdfPagesFromUrl(url);
  }

  @Get('pdf/list')
  @ApiResponse({
    status: 200,
    description: 'An array of all the filenames within the pdfs folder',
    type: [String],
  })
  async getPdfFileList(@Query('dirname') dirname?: string) {
    if (undefined === dirname) {
      dirname = this.RES_PDF;
    } else {
      dirname = this.RES_PDF + dirname;
    }
    return this.fileService.getFilenames(`${dirname}`);
  }

  @Get('pdf/listdir')
  @ApiResponse({
    status: 200,
    description: 'An array of all the directories within the pdfs folder',
    type: [String],
  })
  async getPdfDirList(@Query('dirname') dirname?: string) {
    if (undefined === dirname) {
      dirname = this.RES_PDF;
    } else {
      dirname = this.RES_PDF + dirname;
    }
    return this.fileService.getFoldernames(`${dirname}`);
  }

  @Get('pdf/numpages')
  @ApiResponse({
    status: 200,
    description: 'Returns the number of pages in the pdf',
    type: Number,
  })
  async getNumberOfPages(@Query('filename') filename: string, @Query('dirname') dirname?: string): Promise<number> {
    if (undefined === dirname) {
      dirname = this.RES_PDF;
    } else {
      dirname = this.RES_PDF + dirname;
    }
    return this.fileService.getNumberOfPdfPages(`${dirname}`, `${filename}`);
  }

  @Get('image')
  @ApiResponse({
    status: 200,
    description: 'A Streamed Image',
    type: StreamableFile,
  })
  async getImage(@Query('filename') filename: string, @Response({ passthrough: true }) res): Promise<StreamableFile> {
    return this.fileService.getFileStream('resources/images/', `${filename}`).then((file) => {
      res.set({
        'Content-Type': contentType(filename),
        'Content-Disposition': `attachment; filename=${filename}`,
      });
      return file;
    });
  }

  @Get('image/list')
  @ApiResponse({
    status: 200,
    description: 'An array of all the filenames within the images folder',
    type: [String],
  })
  async getImageFileList() {
    return this.fileService.getFilenames('resources/images/');
  }
}
