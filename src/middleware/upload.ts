import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { AuthRequest } from '../types';

/**
 * Configure multer storage
 */
const storage = multer.diskStorage({
  destination: (req: AuthRequest, file, cb) => {
    // Store in user-specific directory
    const userId = req.user?.userId || 'anonymous';
    const userDir = path.join(config.upload.dir, userId);
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename
    const ext = path.extname(file.originalname);
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  },
});

/**
 * File filter
 */
const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // You can add file type restrictions here
  // For now, accept all files
  cb(null, true);
};

/**
 * Multer upload middleware
 */
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxFileSize,
  },
});
