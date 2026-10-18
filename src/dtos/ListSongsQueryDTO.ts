import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export const SONG_LIST_SORTS = ['newest', 'popular', 'title'] as const;

/** Query parameters for `GET /api/song` (Issue #811). */
export class ListSongsQueryDTO {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsUUID()
  artistId?: string;

  @IsOptional()
  @IsUUID()
  genreId?: string;

  /** Tag slug. */
  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @IsIn(['not_minted', 'pending', 'minted', 'failed'])
  mintStatus?: 'not_minted' | 'pending' | 'minted' | 'failed';

  @IsOptional()
  @IsIn(SONG_LIST_SORTS)
  sort?: (typeof SONG_LIST_SORTS)[number];

  /** Only honoured when the caller lists their own songs (`artistId` is the caller). */
  @IsOptional()
  @IsIn(['processing', 'ready', 'failed'])
  status?: 'processing' | 'ready' | 'failed';
}
