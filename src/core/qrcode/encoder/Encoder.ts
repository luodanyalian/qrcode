/*
 * Copyright 2008 ZXing authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import QRCode from './QRCode';
import MaskUtil from './MaskUtil';
import Mode from '../decoder/Mode';
import BlockPair from './BlockPair';
import ByteMatrix from './ByteMatrix';
import MatrixUtil from './MatrixUtil';
import Version from '../decoder/Version';
import ECBlocks from '../decoder/ECBlocks';
import BitArray from '../../common/BitArray';
import EncodeHintType from '../../EncodeHintType';
import WriterException from '../../WriterException';
import StringEncoding from '../../util/StringEncoding';
import GenericGF from '../../common/reedsolomon/GenericGF';
import CharacterSetECI from '../../common/CharacterSetECI';
import ErrorCorrectionLevel from '../decoder/ErrorCorrectionLevel';
import ReedSolomonEncoder from '../../common/reedsolomon/ReedSolomonEncoder';

/**
 * @author satorux@google.com (Satoru Takabayashi) - creator
 * @author dswitkin@google.com (Daniel Switkin) - ported from C++
 */
export default class Encoder {
  // prettier-ignore
  // The original table is defined in the table 5 of JISX0510:2004 (p.19).
  private static ALPHANUMERIC_TABLE: Int32Array= Int32Array.from([
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  // 0x00-0x0f
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  // 0x10-0x1f
    36, -1, -1, -1, 37, 38, -1, -1, -1, -1, 39, 40, -1, 41, 42, 43,  // 0x20-0x2f
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 44, -1, -1, -1, -1, -1,  // 0x30-0x3f
    -1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,  // 0x40-0x4f
    25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, -1, -1, -1, -1, -1,  // 0x50-0x5f
  ]);

  public static DEFAULT_BYTE_MODE_ENCODING: string = CharacterSetECI.UTF8.getName(); // "ISO-8859-1"
  // TYPESCRIPTPORT: changed to UTF8, the default for js

  // The mask penalty calculation is complicated.  See Table 21 of JISX0510:2004 (p.45) for details.
  // Basically it applies four rules and summate all penalties.
  private static calculateMaskPenalty(matrix: ByteMatrix): number {
    return (
      MaskUtil.applyMaskPenaltyRule1(matrix) +
      MaskUtil.applyMaskPenaltyRule2(matrix) +
      MaskUtil.applyMaskPenaltyRule3(matrix) +
      MaskUtil.applyMaskPenaltyRule4(matrix)
    );
  }

  /**
   * @param content text to encode
   * @param ecLevel error correction level to use
   * @return {@link QRCode} representing the encoded QR code
   * @throws WriterException if encoding can't succeed, because of for example invalid content or configuration
   */
  public static encode(content: string, ecLevel: ErrorCorrectionLevel, hints: Map<EncodeHintType, object> = null): QRCode {
    // Determine what character encoding has been specified by the caller, if any
    let encoding: string = Encoder.DEFAULT_BYTE_MODE_ENCODING;
    const hasEncodingHint: boolean = hints != null && hints.get(EncodeHintType.CHARACTER_SET) != null;

    if (hasEncodingHint) {
      encoding = hints.get(EncodeHintType.CHARACTER_SET).toString();
    }

    // Pick an encoding mode appropriate for the content. Note that this will not attempt to use
    // multiple modes / segments even if that were more efficient. Twould be nice.
    const mode: Mode = this.chooseMode(content, encoding);

    // This will store the header information, like mode and
    // length, as well as "header" segments like an ECI segment.
    const headerBits: BitArray = new BitArray();

    // Append ECI segment if applicable
    if (mode === Mode.BYTE && (hasEncodingHint || Encoder.DEFAULT_BYTE_MODE_ENCODING !== encoding)) {
      const eci: CharacterSetECI = CharacterSetECI.getCharacterSetECIByName(encoding);

      if (eci != null) {
        this.appendECI(eci, headerBits);
      }
    }

    // (With ECI in place,) Write the mode marker
    this.appendModeInfo(mode, headerBits);

    // Collect data within the main segment, separately, to count its size if needed. Don't add it to
    // main payload yet.
    const dataBits: BitArray = new BitArray();

    this.appendBytes(content, mode, dataBits, encoding);

    let version: Version;

    if (hints != null && hints.get(EncodeHintType.QR_VERSION) != null) {
      const versionNumber: number = Number.parseInt(hints.get(EncodeHintType.QR_VERSION).toString(), 10);

      version = Version.getVersionForNumber(versionNumber);

      const bitsNeeded: number = this.calculateBitsNeeded(mode, headerBits, dataBits, version);

      if (!this.willFit(bitsNeeded, version, ecLevel)) {
        throw new WriterException('Data too big for requested version');
      }
    } else {
      version = this.recommendVersion(ecLevel, mode, headerBits, dataBits);
    }

    const headerAndDataBits: BitArray = new BitArray();

    headerAndDataBits.appendBitArray(headerBits);

    // Find "length" of main segment and write it
    const numLetters = mode === Mode.BYTE ? dataBits.getSizeInBytes() : content.length;

    this.appendLengthInfo(numLetters, version, mode, headerAndDataBits);
    // Put data together into the overall payload
    headerAndDataBits.appendBitArray(dataBits);

    const ecBlocks: ECBlocks = version.getECBlocksForLevel(ecLevel);
    const numDataBytes: number = version.getTotalCodewords() - ecBlocks.getTotalECCodewords();

    // Terminate the bits properly.
    this.terminateBits(numDataBytes, headerAndDataBits);

    // Interleave data bits with error correction code.
    const finalBits: BitArray = this.interleaveWithECBytes(
      headerAndDataBits,
      version.getTotalCodewords(),
      numDataBytes,
      ecBlocks.getNumBlocks()
    );

    const qrCode: QRCode = new QRCode();

    qrCode.setECLevel(ecLevel);
    qrCode.setMode(mode);
    qrCode.setVersion(version);

    //  Choose the mask pattern and set to "qrCode".
    const dimension: number = version.getDimensionForVersion();
    const matrix: ByteMatrix = new ByteMatrix(dimension, dimension);
    const maskPattern: number = this.chooseMaskPattern(finalBits, ecLevel, version, matrix);

    qrCode.setMaskPattern(maskPattern);

    // Build the matrix and set it to "qrCode".
    MatrixUtil.buildMatrix(finalBits, ecLevel, version, maskPattern, matrix);
    qrCode.setMatrix(matrix);

    return qrCode;
  }

  /**
   * Decides the smallest version of QR code that will contain all of the provided data.
   *
   * @throws WriterException if the data cannot fit in any version
   */
  private static recommendVersion(
    ecLevel: ErrorCorrectionLevel,
    mode: Mode,
    headerBits: BitArray,
    dataBits: BitArray
  ): Version {
    // Hard part: need to know version to know how many bits length takes. But need to know how many
    // bits it takes to know version. First we take a guess at version by assuming version will be
    // the minimum, 1:
    const provisionalBitsNeeded: number = this.calculateBitsNeeded(mode, headerBits, dataBits, Version.getVersionForNumber(1));
    const provisionalVersion: Version = this.chooseVersion(provisionalBitsNeeded, ecLevel);

    // Use that guess to calculate the right version. I am still not sure this works in 100% of cases.
    const bitsNeeded: number = this.calculateBitsNeeded(mode, headerBits, dataBits, provisionalVersion);

    return this.chooseVersion(bitsNeeded, ecLevel);
  }

  private static calculateBitsNeeded(mode: Mode, headerBits: BitArray, dataBits: BitArray, version: Version): number {
    return headerBits.getSize() + mode.getCharacterCountBits(version) + dataBits.getSize();
  }

  /**
   * @return the code point of the table used in alphanumeric mode or
   *  -1 if there is no corresponding code in the table.
   */
  public static getAlphanumericCode(code: number): number {
    if (code < Encoder.ALPHANUMERIC_TABLE.length) {
      return Encoder.ALPHANUMERIC_TABLE[code];
    }

    return -1;
  }

  /**
   * Choose the best mode by examining the content. Note that 'encoding' is used as a hint;
   * if it is Shift_JIS, and the input is only double-byte Kanji, then we return {@link Mode#KANJI}.
   */
  public static chooseMode(content: string, encoding: string = null): Mode {
    if (CharacterSetECI.SJIS.getName() === encoding && this.isOnlyDoubleByteKanji(content)) {
      // Choose Kanji mode if all input are double-byte characters
      return Mode.KANJI;
    }

    let hasNumeric: boolean = false;
    let hasAlphanumeric: boolean = false;

    for (let i: number = 0, length = content.length; i < length; ++i) {
      const c: string = content.charAt(i);

      if (Encoder.isDigit(c)) {
        hasNumeric = true;
      } else if (this.getAlphanumericCode(c.charCodeAt(0)) !== -1) {
        hasAlphanumeric = true;
      } else {
        return Mode.BYTE;
      }
    }

    if (hasAlphanumeric) {
      return Mode.ALPHANUMERIC;
    }

    if (hasNumeric) {
      return Mode.NUMERIC;
    }

    return Mode.BYTE;
  }

  private static isOnlyDoubleByteKanji(content: string): boolean {
    let bytes: Uint8Array;

    try {
      bytes = StringEncoding.encode(content, CharacterSetECI.SJIS); // content.getBytes("Shift_JIS"))
    } catch (ignored) {
      return false;
    }

    const length: number = bytes.length;

    if (length % 2 !== 0) {
      return false;
    }

    for (let i = 0; i < length; i += 2) {
      const byte1: number = bytes[i] & 0xff;

      if ((byte1 < 0x81 || byte1 > 0x9f) && (byte1 < 0xe0 || byte1 > 0xeb)) {
        return false;
      }
    }

    return true;
  }

  private static chooseMaskPattern(
    bits: BitArray,
    ecLevel: ErrorCorrectionLevel,
    version: Version,
    matrix: ByteMatrix
  ): number {
    let minPenalty: number = Number.MAX_SAFE_INTEGER; // Lower penalty is better.
    let bestMaskPattern: number = -1;

    // We try all mask patterns to choose the best one.
    for (let maskPattern: number = 0; maskPattern < QRCode.NUM_MASK_PATTERNS; maskPattern++) {
      MatrixUtil.buildMatrix(bits, ecLevel, version, maskPattern, matrix);

      let penalty: number = this.calculateMaskPenalty(matrix);

      if (penalty < minPenalty) {
        minPenalty = penalty;
        bestMaskPattern = maskPattern;
      }
    }

    return bestMaskPattern;
  }

  private static chooseVersion(numInputBits: number, ecLevel: ErrorCorrectionLevel): Version {
    for (let versionNum = 1; versionNum <= 40; versionNum++) {
      const version: Version = Version.getVersionForNumber(versionNum);

      if (Encoder.willFit(numInputBits, version, ecLevel)) {
        return version;
      }
    }

    throw new WriterException('Data too big');
  }

  /**
   * @return true if the number of input bits will fit in a code with the specified version and
   * error correction level.
   */
  private static willFit(numInputBits: number, version: Version, ecLevel: ErrorCorrectionLevel): boolean {
    // In the following comments, we use numbers of Version 7-H.
    // numBytes = 196
    const numBytes: number = version.getTotalCodewords();
    // getNumECBytes = 130
    const ecBlocks: ECBlocks = version.getECBlocksForLevel(ecLevel);
    const numEcBytes: number = ecBlocks.getTotalECCodewords();
    // getNumDataBytes = 196 - 130 = 66
    const numDataBytes: number = numBytes - numEcBytes;
    const totalInputBytes: number = (numInputBits + 7) / 8;

    return numDataBytes >= totalInputBytes;
  }

  /**
   * Terminate bits as described in 8.4.8 and 8.4.9 of JISX0510:2004 (p.24).
   */
  public static terminateBits(numDataBytes: number, bits: BitArray): void {
    const capacity: number = numDataBytes * 8;

    if (bits.getSize() > capacity) {
      throw new WriterException('data bits cannot fit in the QR Code' + bits.getSize() + ' > ' + capacity);
    }

    for (let i: number = 0; i < 4 && bits.getSize() < capacity; ++i) {
      bits.appendBit(false);
    }

    // Append termination bits. See 8.4.8 of JISX0510:2004 (p.24) for details.
    // If the last byte isn't 8-bit aligned, we'll add padding bits.
    const numBitsInLastByte: number = bits.getSize() & 0x07;

    if (numBitsInLastByte > 0) {
      for (let i: number = numBitsInLastByte; i < 8; i++) {
        bits.appendBit(false);
      }
    }

    // If we have more space, we'll fill the space with padding patterns defined in 8.4.9 (p.24).
    const numPaddingBytes: number = numDataBytes - bits.getSizeInBytes();

    for (let i: number = 0; i < numPaddingBytes; ++i) {
      bits.appendBits((i & 0x01) === 0 ? 0xec : 0x11, 8);
    }

    if (bits.getSize() !== capacity) {
      throw new WriterException('Bits size does not equal capacity');
    }
  }

  /**
   * Get number of data bytes and number of error correction bytes for block id "blockID". Store
   * the result in "numDataBytesInBlock", and "numECBytesInBlock". See table 12 in 8.5.1 of
   * JISX0510:2004 (p.30)
   */
  public static getNumDataBytesAndNumECBytesForBlockID(
    numTotalBytes: number,
    numDataBytes: number,
    numRSBlocks: number,
    blockID: number,
    numDataBytesInBlock: Int32Array,
    numECBytesInBlock: Int32Array
  ): void {
    if (blockID >= numRSBlocks) {
      throw new WriterException('Block ID too large');
    }

    // numRsBlocksInGroup2 = 196 % 5 = 1
    const numRsBlocksInGroup2: number = numTotalBytes % numRSBlocks;
    // numRsBlocksInGroup1 = 5 - 1 = 4
    const numRsBlocksInGroup1: number = numRSBlocks - numRsBlocksInGroup2;
    // numTotalBytesInGroup1 = 196 / 5 = 39
    const numTotalBytesInGroup1: number = Math.floor(numTotalBytes / numRSBlocks);
    // numTotalBytesInGroup2 = 39 + 1 = 40
    const numTotalBytesInGroup2: number = numTotalBytesInGroup1 + 1;
    // numDataBytesInGroup1 = 66 / 5 = 13
    const numDataBytesInGroup1: number = Math.floor(numDataBytes / numRSBlocks);
    // numDataBytesInGroup2 = 13 + 1 = 14
    const numDataBytesInGroup2: number = numDataBytesInGroup1 + 1;
    // numEcBytesInGroup1 = 39 - 13 = 26
    const numEcBytesInGroup1: number = numTotalBytesInGroup1 - numDataBytesInGroup1;
    // numEcBytesInGroup2 = 40 - 14 = 26
    const numEcBytesInGroup2: number = numTotalBytesInGroup2 - numDataBytesInGroup2;

    // Sanity checks.
    // 26 = 26
    if (numEcBytesInGroup1 !== numEcBytesInGroup2) {
      throw new WriterException('EC bytes mismatch');
    }

    // 5 = 4 + 1.
    if (numRSBlocks !== numRsBlocksInGroup1 + numRsBlocksInGroup2) {
      throw new WriterException('RS blocks mismatch');
    }

    // 196 = (13 + 26) * 4 + (14 + 26) * 1
    if (
      numTotalBytes !==
      (numDataBytesInGroup1 + numEcBytesInGroup1) * numRsBlocksInGroup1 +
        (numDataBytesInGroup2 + numEcBytesInGroup2) * numRsBlocksInGroup2
    ) {
      throw new WriterException('Total bytes mismatch');
    }

    if (blockID < numRsBlocksInGroup1) {
      numDataBytesInBlock[0] = numDataBytesInGroup1;
      numECBytesInBlock[0] = numEcBytesInGroup1;
    } else {
      numDataBytesInBlock[0] = numDataBytesInGroup2;
      numECBytesInBlock[0] = numEcBytesInGroup2;
    }
  }

  /**
   * Interleave "bits" with corresponding error correction bytes. On success, store the result in
   * "result". The interleave rule is complicated. See 8.6 of JISX0510:2004 (p.37) for details.
   */
  public static interleaveWithECBytes(
    bits: BitArray,
    numTotalBytes: number,
    numDataBytes: number,
    numRSBlocks: number
  ): BitArray {
    // "bits" must have "getNumDataBytes" bytes of data.
    if (bits.getSizeInBytes() !== numDataBytes) {
      throw new WriterException('Number of bits and data bytes does not match');
    }

    // Step 1.  Divide data bytes into blocks and generate error correction bytes for them. We'll
    // store the divided data bytes blocks and error correction bytes blocks into "blocks".
    let dataBytesOffset: number = 0;
    let maxNumDataBytes: number = 0;
    let maxNumEcBytes: number = 0;

    // Since, we know the number of reedsolmon blocks, we can initialize the vector with the number.
    const blocks: BlockPair[] = new Array<BlockPair>(); // new Array<BlockPair>(numRSBlocks)

    for (let i: number = 0; i < numRSBlocks; ++i) {
      const numDataBytesInBlock: Int32Array = new Int32Array(1);
      const numEcBytesInBlock: Int32Array = new Int32Array(1);

      Encoder.getNumDataBytesAndNumECBytesForBlockID(
        numTotalBytes,
        numDataBytes,
        numRSBlocks,
        i,
        numDataBytesInBlock,
        numEcBytesInBlock
      );

      const size: number = numDataBytesInBlock[0];
      const dataBytes: Uint8Array = new Uint8Array(size);

      bits.toBytes(8 * dataBytesOffset, dataBytes, 0, size);

      const ecBytes: Uint8Array = Encoder.generateECBytes(dataBytes, numEcBytesInBlock[0]);

      blocks.push(new BlockPair(dataBytes, ecBytes));

      maxNumDataBytes = Math.max(maxNumDataBytes, size);
      maxNumEcBytes = Math.max(maxNumEcBytes, ecBytes.length);
      dataBytesOffset += numDataBytesInBlock[0];
    }

    if (numDataBytes !== dataBytesOffset) {
      throw new WriterException('Data bytes does not match offset');
    }

    const result: BitArray = new BitArray();

    // First, place data blocks.
    for (let i: number = 0; i < maxNumDataBytes; ++i) {
      for (const block of blocks) {
        const dataBytes: Uint8Array = block.getDataBytes();

        if (i < dataBytes.length) {
          result.appendBits(dataBytes[i], 8);
        }
      }
    }

    // Then, place error correction blocks.
    for (let i: number = 0; i < maxNumEcBytes; ++i) {
      for (const block of blocks) {
        const ecBytes: Uint8Array = block.getErrorCorrectionBytes();

        if (i < ecBytes.length) {
          result.appendBits(ecBytes[i], 8);
        }
      }
    }

    if (numTotalBytes !== result.getSizeInBytes()) {
      // Should be same.
      throw new WriterException('Interleaving error: ' + numTotalBytes + ' and ' + result.getSizeInBytes() + ' differ.');
    }

    return result;
  }

  public static generateECBytes(dataBytes: Uint8Array, numEcBytesInBlock: number): Uint8Array {
    const numDataBytes: number = dataBytes.length;
    const toEncode: Int32Array = new Int32Array(numDataBytes + numEcBytesInBlock); // int[numDataBytes + numEcBytesInBlock]

    for (let i: number = 0; i < numDataBytes; i++) {
      toEncode[i] = dataBytes[i] & 0xff;
    }

    new ReedSolomonEncoder(GenericGF.QR_CODE_FIELD_256).encode(toEncode, numEcBytesInBlock);

    const ecBytes: Uint8Array = new Uint8Array(numEcBytesInBlock);

    for (let i = 0; i < numEcBytesInBlock; i++) {
      ecBytes[i] = toEncode[numDataBytes + i];
    }

    return ecBytes;
  }

  /**
   * Append mode info. On success, store the result in "bits".
   */
  public static appendModeInfo(mode: Mode, bits: BitArray): void {
    bits.appendBits(mode.getBits(), 4);
  }

  /**
   * Append length info. On success, store the result in "bits".
   */
  public static appendLengthInfo(numLetters: number, version: Version, mode: Mode, bits: BitArray): void {
    const numBits: number = mode.getCharacterCountBits(version);

    if (numLetters >= 1 << numBits) {
      throw new WriterException(numLetters + ' is bigger than ' + ((1 << numBits) - 1));
    }

    bits.appendBits(numLetters, numBits);
  }

  /**
   * Append "bytes" in "mode" mode (encoding) into "bits". On success, store the result in "bits".
   */
  public static appendBytes(content: string, mode: Mode, bits: BitArray, encoding: string): void {
    switch (mode) {
      case Mode.NUMERIC:
        Encoder.appendNumericBytes(content, bits);
        break;
      case Mode.ALPHANUMERIC:
        Encoder.appendAlphanumericBytes(content, bits);
        break;
      case Mode.BYTE:
        Encoder.append8BitBytes(content, bits, encoding);
        break;
      case Mode.KANJI:
        Encoder.appendKanjiBytes(content, bits);
        break;
      default:
        throw new WriterException('Invalid mode: ' + mode);
    }
  }

  private static getDigit(singleCharacter: string): number {
    return singleCharacter.charCodeAt(0) - 48;
  }

  private static isDigit(singleCharacter: string): boolean {
    const cn: number = Encoder.getDigit(singleCharacter);

    return cn >= 0 && cn <= 9;
  }

  public static appendNumericBytes(content: string, bits: BitArray): void {
    const length: number = content.length;
    let i: number = 0;

    while (i < length) {
      const num1: number = Encoder.getDigit(content.charAt(i));

      if (i + 2 < length) {
        // Encode three numeric letters in ten bits.
        const num2: number = Encoder.getDigit(content.charAt(i + 1));
        const num3: number = Encoder.getDigit(content.charAt(i + 2));

        bits.appendBits(num1 * 100 + num2 * 10 + num3, 10);
        i += 3;
      } else if (i + 1 < length) {
        // Encode two numeric letters in seven bits.
        const num2: number = Encoder.getDigit(content.charAt(i + 1));

        bits.appendBits(num1 * 10 + num2, 7);
        i += 2;
      } else {
        // Encode one numeric letter in four bits.
        bits.appendBits(num1, 4);
        i++;
      }
    }
  }

  public static appendAlphanumericBytes(content: string, bits: BitArray): void /*throws WriterException*/ {
    const length: number = content.length;
    let i: number = 0;

    while (i < length) {
      const code1: number = Encoder.getAlphanumericCode(content.charCodeAt(i));

      if (code1 === -1) {
        throw new WriterException();
      }

      if (i + 1 < length) {
        const code2: number = Encoder.getAlphanumericCode(content.charCodeAt(i + 1));

        if (code2 === -1) {
          throw new WriterException();
        }

        // Encode two alphanumeric letters in 11 bits.
        bits.appendBits(code1 * 45 + code2, 11);
        i += 2;
      } else {
        // Encode one alphanumeric letter in six bits.
        bits.appendBits(code1, 6);
        i++;
      }
    }
  }

  public static append8BitBytes(content: string, bits: BitArray, encoding: string): void {
    let bytes: Uint8Array;

    try {
      bytes = StringEncoding.encode(content, encoding);
    } catch (uee) {
      throw new WriterException(uee);
    }

    for (let i: number = 0, length = bytes.length; i !== length; i++) {
      const b: number = bytes[i];

      bits.appendBits(b, 8);
    }
  }

  /**
   * @throws WriterException
   */
  public static appendKanjiBytes(content: string, bits: BitArray): void {
    let bytes: Uint8Array;

    try {
      bytes = StringEncoding.encode(content, CharacterSetECI.SJIS);
    } catch (uee) {
      throw new WriterException(uee);
    }

    const length: number = bytes.length;

    for (let i: number = 0; i < length; i += 2) {
      const byte1: number = bytes[i] & 0xff;
      const byte2: number = bytes[i + 1] & 0xff;
      const code: number = ((byte1 << 8) & 0xffffffff) | byte2;
      let subtracted: number = -1;

      if (code >= 0x8140 && code <= 0x9ffc) {
        subtracted = code - 0x8140;
      } else if (code >= 0xe040 && code <= 0xebbf) {
        subtracted = code - 0xc140;
      }

      if (subtracted === -1) {
        throw new WriterException('Invalid byte sequence');
      }

      const encoded: number = (subtracted >> 8) * 0xc0 + (subtracted & 0xff);

      bits.appendBits(encoded, 13);
    }
  }

  private static appendECI(eci: CharacterSetECI, bits: BitArray): void {
    bits.appendBits(Mode.ECI.getBits(), 4);
    // This is correct for values up to 127, which is all we need now.
    bits.appendBits(eci.getValue(), 8);
  }
}