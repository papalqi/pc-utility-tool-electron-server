import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { config } from '../config';

/**
 * Multer middleware for uploading auto-update artifacts.
 *
 * Notes:
 * - Keep original file names (latest.yml, *.exe, *.zip, *.blockmap, ...)
 * - Store all files in a shared directory (not per-user)
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const updatesDir = config.updates.dir;
    fs.mkdir(updatesDir, { recursive: true }, (err) => {
      cb(err, updatesDir);
    });
  },
  filename: (_req, file, cb) => {
    cb(null, path.basename(file.originalname));
  },
});

export const updateUpload = multer({
  storage,
  limits: {
    fileSize: config.updates.maxFileSize,
  },
});
