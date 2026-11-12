const { desktopCapturer } = require('electron');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('OCR');
const config = require('../core/config');

class OCRService {
  constructor() {
    this.isProcessing = false;
    this.tempFiles = new Set();
    this.screenshotBuffer = [];
  }

  addScreenshotToBuffer(screenshotData) {
    this.screenshotBuffer.push(screenshotData);
    logger.info('Screenshot added to buffer', {
      bufferCount: this.screenshotBuffer.length,
      hasBuffer: !!screenshotData.buffer,
      textLength: screenshotData.text ? screenshotData.text.length : 0
    });
    return this.screenshotBuffer.length;
  }

  getScreenshotBuffer() {
    return [...this.screenshotBuffer];
  }

  getBufferCount() {
    return this.screenshotBuffer.length;
  }

  clearScreenshotBuffer() {
    const count = this.screenshotBuffer.length;
    this.screenshotBuffer = [];
    logger.info('Screenshot buffer cleared', { previousCount: count });
    return count;
  }

  async captureAndBufferScreenshot(runOcr = false) {
    logger.info('Capturing screenshot and adding to buffer (Vision-optimized)');
    const screenshot = await this.captureScreenshot();
    const downscaled = this.downscaleAndCompressImage(screenshot.image, 1600, 85);
    const imageBase64 = `data:${downscaled.mimeType};base64,${downscaled.base64}`;

    let extractedText = '';
    if (runOcr) {
      try {
        extractedText = await this.performOCR({
          image: downscaled.image || screenshot.image,
          metadata: screenshot.metadata
        });
      } catch (ocrErr) {
        logger.warn('OCR extraction skipped/failed on buffered screenshot', { error: ocrErr.message });
      }
    }

    const item = {
      buffer: downscaled.buffer,
      imageBase64,
      rawBase64: downscaled.base64,
      mimeType: downscaled.mimeType,
      text: (extractedText || '').trim(),
      metadata: {
        timestamp: new Date().toISOString(),
        source: screenshot.metadata,
        dimensions: { width: downscaled.width, height: downscaled.height }
      }
    };

    const count = this.addScreenshotToBuffer(item);
    return {
      count,
      item
    };
  }

  downscaleAndCompressImage(nativeImg, maxDimension = 1600, quality = 85) {
    if (!nativeImg || typeof nativeImg.getSize !== 'function') {
      return {
        image: nativeImg,
        buffer: null,
        base64: null,
        mimeType: 'image/jpeg',
        width: 0,
        height: 0
      };
    }

    const size = nativeImg.getSize();
    let { width, height } = size;

    if (width > maxDimension || height > maxDimension) {
      if (width >= height) {
        height = Math.max(1, Math.round((height / width) * maxDimension));
        width = maxDimension;
      } else {
        width = Math.max(1, Math.round((width / height) * maxDimension));
        height = maxDimension;
      }
    }

    const resized = nativeImg.resize({ width, height, quality: 'better' });
    const buffer = typeof resized.toJPEG === 'function' ? resized.toJPEG(quality) : resized.toPNG();
    const base64 = buffer.toString('base64');
    const mimeType = typeof resized.toJPEG === 'function' ? 'image/jpeg' : 'image/png';

    return {
      image: resized,
      buffer,
      base64,
      width,
      height,
      mimeType
    };
  }

  downscaleBase64Image(base64Str, maxDimension = 1600, quality = 85) {
    if (!base64Str || typeof base64Str !== 'string') return base64Str;
    try {
      const { nativeImage } = require('electron');
      let img;
      if (base64Str.startsWith('data:image/')) {
        img = nativeImage.createFromDataURL(base64Str);
      } else {
        const cleanBase64 = base64Str.replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '').trim();
        img = nativeImage.createFromBuffer(Buffer.from(cleanBase64, 'base64'));
      }
      if (!img || img.isEmpty()) return base64Str;
      const downscaled = this.downscaleAndCompressImage(img, maxDimension, quality);
      return `data:${downscaled.mimeType};base64,${downscaled.base64}`;
    } catch (err) {
      logger.warn('Failed to downscale base64 image', { error: err.message });
      return base64Str;
    }
  }

  async captureAndProcess(runOcr = false) {
    if (this.isProcessing) {
      throw new Error('OCR operation already in progress');
    }

    this.isProcessing = true;
    const startTime = Date.now();
    
    try {
      logger.info('Starting screenshot capture and high-speed processing');
      
      const screenshot = await this.captureScreenshot();
      const downscaled = this.downscaleAndCompressImage(screenshot.image, 1600, 85);
      const imageBase64 = `data:${downscaled.mimeType};base64,${downscaled.base64}`;

      let extractedText = '';
      if (runOcr) {
        try {
          extractedText = await this.performOCR({
            image: downscaled.image || screenshot.image,
            metadata: screenshot.metadata
          });
        } catch (ocrErr) {
          logger.warn('Local OCR skipped in favor of multimodal vision', { error: ocrErr.message });
        }
      }
      
      logger.logPerformance('Screenshot processing', startTime, {
        hasImage: !!imageBase64,
        imageBytes: downscaled.buffer ? downscaled.buffer.length : 0,
        dimensions: { width: downscaled.width, height: downscaled.height }
      });

      return {
        text: (extractedText || '').trim(),
        imageBase64,
        rawBase64: downscaled.base64,
        buffer: downscaled.buffer,
        mimeType: downscaled.mimeType,
        metadata: {
          timestamp: new Date().toISOString(),
          source: screenshot.metadata,
          processingTime: Date.now() - startTime,
          dimensions: { width: downscaled.width, height: downscaled.height }
        }
      };
    } finally {
      this.isProcessing = false;
      this.cleanup();
    }
  }

  async captureScreenshot() {
    let captureWidth = 1920;
    let captureHeight = 1080;
    try {
      const { screen } = require('electron');
      if (screen && typeof screen.getPrimaryDisplay === 'function') {
        const display = screen.getPrimaryDisplay();
        const scale = display.scaleFactor || 1;
        captureWidth = Math.round((display.size?.width || 1920) * scale);
        captureHeight = Math.round((display.size?.height || 1080) * scale);
      }
    } catch (_) {}

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: captureWidth, height: captureHeight }
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available for capture');
    }

    let targetSource = sources[0];
    try {
      const { screen } = require('electron');
      if (screen && typeof screen.getCursorScreenPoint === 'function' && typeof screen.getDisplayNearestPoint === 'function') {
        const cursorPoint = screen.getCursorScreenPoint();
        const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
        if (currentDisplay && sources.length > 1) {
          const match = sources.find(s => s.display_id === String(currentDisplay.id) || s.name.includes(String(currentDisplay.id)));
          if (match) {
            targetSource = match;
          }
        }
      }
    } catch (_) {}

    const image = targetSource.thumbnail;

    if (!image) {
      throw new Error('Failed to capture screen thumbnail');
    }

    logger.debug('Screenshot captured successfully', {
      sourceName: targetSource.name,
      imageSize: image.getSize()
    });

    return {
      image,
      metadata: {
        sourceName: targetSource.name,
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  async performOCR(screenshot) {
    const tempPath = this.createTempFile(screenshot.image);
    
    try {
      logger.debug('Starting OCR text extraction', { tempPath });
      
      const { data: { text } } = await Tesseract.recognize(tempPath, config.get('ocr.language'), {
        logger: progress => {
          if (progress.status === 'recognizing text') {
            logger.debug(`OCR progress: ${Math.round(progress.progress * 100)}%`);
          }
        }
      });

      const cleanText = this.sanitizeText(text);
      
      logger.info('OCR text extraction completed', {
        originalLength: text.length,
        cleanedLength: cleanText.length,
        wordsExtracted: cleanText.split(/\s+/).filter(w => w.length > 0).length
      });

      return cleanText;
    } catch (error) {
      logger.error('OCR processing failed', { error: error.message, tempPath });
      throw new Error(`Text extraction failed: ${error.message}`);
    }
  }

  createTempFile(image) {
    const tempPath = path.join(
      config.get('ocr.tempDir'), 
      `Vysper-screenshot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.png`
    );
    
    const buffer = image.toPNG();
    fs.writeFileSync(tempPath, buffer);
    
    this.tempFiles.add(tempPath);
    logger.debug('Temporary screenshot file created', { tempPath, size: buffer.length });
    
    return tempPath;
  }

  sanitizeText(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/[^\x20-\x7E\n]/g, '')
      .trim();
  }

  cleanup() {
    for (const tempFile of this.tempFiles) {
      try {
        fs.unlinkSync(tempFile);
        logger.debug('Cleaned up temporary file', { file: tempFile });
      } catch (error) {
        logger.warn('Failed to cleanup temporary file', { 
          file: tempFile, 
          error: error.message 
        });
      }
    }
    this.tempFiles.clear();
  }

  getStatus() {
    return {
      isProcessing: this.isProcessing,
      tempFilesCount: this.tempFiles.size,
      bufferCount: this.screenshotBuffer.length,
      config: {
        language: config.get('ocr.language'),
        tempDir: config.get('ocr.tempDir')
      }
    };
  }

  async generateResponse(image, skillContext) {
    const llmService = require('./llm.service');
    return llmService.generateResponse(image, skillContext);
  }
}

module.exports = new OCRService(); 