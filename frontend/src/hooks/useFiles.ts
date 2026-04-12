import { useState, useCallback } from 'preact/hooks';
import { get, post } from '../api/client';
import type { FileListResponse } from '../api/types';

const BASE_URL = import.meta.env.DEV ? '/api' : '/api';

export type Drive = 'music' | 'lightshow' | 'boombox';

export function useFiles() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listFiles = useCallback(async (drive: Drive, path: string = '/'): Promise<FileListResponse | null> => {
    setLoading(true);
    setError(null);
    try {
      const data = await get<FileListResponse>(`/files/${drive}/ls?path=${encodeURIComponent(path)}`);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list files');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const uploadFile = useCallback(async (
    drive: Drive,
    path: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', path);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        resolve(xhr.status >= 200 && xhr.status < 300);
      });

      xhr.addEventListener('error', () => {
        resolve(false);
      });

      xhr.open('POST', `${BASE_URL}/files/${drive}/upload`);
      xhr.send(formData);
    });
  }, []);

  const createFolder = useCallback(async (drive: Drive, path: string, name: string): Promise<boolean> => {
    try {
      await post(`/files/${drive}/mkdir`, { path, name });
      return true;
    } catch {
      return false;
    }
  }, []);

  const deleteItems = useCallback(async (drive: Drive, paths: string[]): Promise<boolean> => {
    try {
      await post(`/files/${drive}/rm`, { paths });
      return true;
    } catch {
      return false;
    }
  }, []);

  const moveItem = useCallback(async (drive: Drive, src: string, dest: string): Promise<boolean> => {
    try {
      await post(`/files/${drive}/mv`, { src, dest });
      return true;
    } catch {
      return false;
    }
  }, []);

  const copyItem = useCallback(async (drive: Drive, src: string, dest: string): Promise<boolean> => {
    try {
      await post(`/files/${drive}/cp`, { src, dest });
      return true;
    } catch {
      return false;
    }
  }, []);

  const getDownloadUrl = useCallback((drive: Drive, path: string): string => {
    return `${BASE_URL}/files/${drive}/download?path=${encodeURIComponent(path)}`;
  }, []);

  return {
    loading,
    error,
    listFiles,
    uploadFile,
    createFolder,
    deleteItems,
    moveItem,
    copyItem,
    getDownloadUrl,
  };
}
