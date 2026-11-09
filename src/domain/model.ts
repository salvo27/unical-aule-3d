import type { PlannerId } from './primitives.js';

export interface RoomInfo {
  id: PlannerId;
  name: string;
  code: string;
  buildingName: string;
  capacity: number | null;
  effectiveCapacity: number | null;
  services: string[];
}

export type LessonStatus = 'active' | 'cancelled';

export interface Lesson {
  id: PlannerId;
  title: string;
  start: number;
  end: number;
  status: LessonStatus;
  kind: string;
  courses: string[];
  year: number | null;
  teachers: string[];
  roomIds: PlannerId[];
}
