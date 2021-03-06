/**
 * @module QRCode
 * @author nuintun
 * @author Cosmo Wolfe
 */

import { Point } from './Point';
import { BitMatrix } from './BitMatrix';
import { locate, QRLocation } from './locator';
import { decode, DecodeResult } from './decoder';
import { extract, ExtractResult } from './extractor';
import { binarize, BinarizeResult } from './binarizer';

export interface DecoderResult extends DecodeResult {
  location: {
    topLeft: Point;
    topRight: Point;
    bottomLeft: Point;
    bottomRight: Point;
    topLeftFinder: Point;
    topRightFinder: Point;
    bottomLeftFinder: Point;
    bottomRightAlignment: Point | null;
  };
}

function scan(matrix: BitMatrix): DecoderResult {
  const location: QRLocation = locate(matrix);

  if (!location) {
    return null;
  }

  const extracted: ExtractResult = extract(matrix, location);
  const decoded: DecodeResult = decode(extracted.matrix);

  if (!decoded) {
    return null;
  }

  const dimension: number = location.dimension;

  return {
    ...decoded,
    location: {
      topLeft: extracted.mappingFunction(0, 0),
      topRight: extracted.mappingFunction(dimension, 0),
      bottomLeft: extracted.mappingFunction(0, dimension),
      bottomRight: extracted.mappingFunction(dimension, dimension),
      topLeftFinder: location.topLeft,
      topRightFinder: location.topRight,
      bottomLeftFinder: location.bottomLeft,
      bottomRightAlignment: decoded.version > 1 ? location.alignmentPattern : null
    }
  };
}

export interface Options {
  inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst';
}

const defaultOptions: Options = {
  inversionAttempts: 'attemptBoth'
};

function disposeImageEvents(image: HTMLImageElement): void {
  image.onload = null;
  image.onerror = null;
}

export class Decoder {
  private options: Options = defaultOptions;

  /**
   * @public
   * @method setOptions
   * @param {object} options
   */
  public setOptions(options: Options = {}): void {
    options = options || {};

    this.options = { ...defaultOptions, ...options };
  }

  /**
   * @public
   * @method decode
   * @param {Uint8ClampedArray} data
   * @param {number} width
   * @param {number} height
   * @returns {DecoderResult}
   */
  public decode(data: Uint8ClampedArray, width: number, height: number): DecoderResult {
    const options: Options = this.options;
    const shouldInvert: boolean = options.inversionAttempts === 'attemptBoth' || options.inversionAttempts === 'invertFirst';
    const tryInvertedFirst: boolean = options.inversionAttempts === 'onlyInvert' || options.inversionAttempts === 'invertFirst';
    const { binarized, inverted }: BinarizeResult = binarize(data, width, height, shouldInvert);

    let result: DecoderResult = scan(tryInvertedFirst ? inverted : binarized);

    if (!result && (options.inversionAttempts === 'attemptBoth' || options.inversionAttempts === 'invertFirst')) {
      result = scan(tryInvertedFirst ? binarized : inverted);
    }

    return result;
  }

  /**
   * @public
   * @method scan
   * @param {string} src
   * @returns {Promise}
   */
  public scan(src: string): Promise<DecoderResult> {
    return new Promise((resolve, reject) => {
      const image: HTMLImageElement = new Image();

      // Image cross origin
      image.crossOrigin = 'anonymous';

      image.onload = () => {
        disposeImageEvents(image);

        const width: number = image.width;
        const height: number = image.height;
        const canvas: HTMLCanvasElement = document.createElement('canvas');
        const context: CanvasRenderingContext2D = canvas.getContext('2d');

        canvas.width = width;
        canvas.height = height;

        context.drawImage(image, 0, 0);

        const data: Uint8ClampedArray = context.getImageData(0, 0, width, height).data;
        const result: DecoderResult = this.decode(data, width, height);

        if (result) {
          return resolve(result);
        }

        return reject('failed to decode image');
      };

      image.onerror = () => {
        disposeImageEvents(image);

        reject(`failed to load image: ${src}`);
      };

      image.src = src;
    });
  }
}
