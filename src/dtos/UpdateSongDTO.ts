import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for `PATCH /api/song/:id`: only these fields are editable. */
export class UpdateSongDTO {
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(200, { message: 'Title must be 200 characters or fewer.' })
  title?: string;

  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(2000, { message: 'Description must be 2000 characters or fewer.' })
  description?: string;

  @IsString()
  @IsOptional()
  genreId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500, { message: 'Composers must be 500 characters or fewer.' })
  composers?: string;

  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(20000, { message: 'Lyrics must be 20000 characters or fewer.' })
  lyrics?: string;

  @IsString()
  @IsOptional()
  @MaxLength(35, { message: 'Language must be 35 characters or fewer.' })
  language?: string;
}
