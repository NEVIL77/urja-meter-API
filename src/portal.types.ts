import type { PortalLevel } from "./portal.js";

export interface RawNode { code: string; name: string }

export interface RawExportMeter {
  meterId: string;
  serialNo: string;
  make: string;
  phaseType: string;
  installStatus: string;
  installType: string;
  dtCode: string;
  build: string;
  geo: { lat: number; lng: number };
  hierarchy: Record<PortalLevel, RawNode>;
}

export interface RawTransformer { code: string; name: string; feederCode: string; capacityKva: number }

export interface RawReading { timestamp: string; kwh: string; kvah: string; voltR: string }

export interface PortalOptions {
  baseUrl: string;
  email: string;
  password: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  rate?: { burst: number; perSecond: number };
}

export type HeaderMap = Record<string, string>;
