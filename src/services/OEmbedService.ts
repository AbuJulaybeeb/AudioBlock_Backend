import { AppError, ErrorType } from '../errors/AppError';
import { EmbedService } from './EmbedService';

export interface OEmbedResponse {
  version: '1.0';
  type: 'rich';
  provider_name: string;
  provider_url: string;
  title: string;
  author_name?: string;
  author_url: string;
  thumbnail_url?: string;
  html: string;
  width: number;
  height: number;
}

const PROVIDER_NAME = 'AudioBlocks';

const PLAYER_SIZE = {
  song: { width: 480, height: 180 },
  album: { width: 480, height: 400 },
} as const;

function listenerHosts(): Set<string> {
  const hosts = new Set<string>();
  const sources = [process.env.APP_URL, ...(process.env.FRONTEND_URLS?.split(',') ?? [])];
  for (const source of sources) {
    const value = source?.trim();
    if (!value) continue;
    try {
      hosts.add(new URL(value.includes('://') ? value : `https://${value}`).host.toLowerCase());
    } catch {
      // ignore malformed entries
    }
  }
  return hosts;
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export class OEmbedService {
  private embedService = new EmbedService();

  async getOEmbed(params: {
    url?: string;
    maxwidth?: unknown;
    maxheight?: unknown;
    format?: string;
  }): Promise<OEmbedResponse> {
    if (params.format && params.format !== 'json') {
      throw new AppError(
        'Only format=json is supported',
        ErrorType.BUSINESS_LOGIC_ERROR,
        501,
        true,
        undefined,
        'OEMBED_FORMAT_NOT_IMPLEMENTED',
      );
    }

    const { origin, kind, id } = this.parseResourceUrl(params.url);

    const size = PLAYER_SIZE[kind];
    const maxWidth = parsePositiveInt(params.maxwidth);
    const maxHeight = parsePositiveInt(params.maxheight);
    const width = maxWidth ? Math.min(size.width, maxWidth) : size.width;
    const height = maxHeight ? Math.min(size.height, maxHeight) : size.height;

    // EmbedService rejects unknown, unready and flagged songs with a 404
    const data =
      kind === 'song'
        ? await this.embedService.getSongEmbed(id)
        : await this.embedService.getAlbumEmbed(id);

    const playerUrl = `${origin}/embed/${kind}/${encodeURIComponent(id)}`;
    return {
      version: '1.0',
      type: 'rich',
      provider_name: PROVIDER_NAME,
      provider_url: origin,
      title: data.title,
      author_name: data.artist.name || data.artist.username,
      author_url: `${origin}/artist/${encodeURIComponent(data.artist.id)}`,
      thumbnail_url: data.coverArtPath || undefined,
      html: `<iframe src="${escapeHtmlAttr(playerUrl)}" width="${width}" height="${height}" frameborder="0" allow="autoplay" title="${escapeHtmlAttr(data.title)}"></iframe>`,
      width,
      height,
    };
  }

  private parseResourceUrl(raw?: string): { origin: string; kind: 'song' | 'album'; id: string } {
    let url: URL;
    try {
      url = new URL(raw ?? '');
    } catch {
      throw AppError.validation(
        'A valid url parameter is required',
        undefined,
        'OEMBED_INVALID_URL',
      );
    }

    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !listenerHosts().has(url.host.toLowerCase())
    ) {
      throw AppError.validation('URL is not an AudioBlocks URL', undefined, 'OEMBED_FOREIGN_HOST');
    }

    const match = /^\/(song|album)\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) {
      throw AppError.validation(
        'URL does not point to a song or album',
        undefined,
        'OEMBED_INVALID_URL',
      );
    }

    return {
      origin: url.origin,
      kind: match[1] as 'song' | 'album',
      id: decodeURIComponent(match[2]),
    };
  }
}

export default OEmbedService;
