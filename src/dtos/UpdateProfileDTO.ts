import { IsOptional, IsString, IsBoolean, IsUrl } from 'class-validator';

export class UpdateProfileDTO {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsUrl()
  website?: string;

  @IsOptional()
  @IsString()
  profileImage?: string;

  @IsOptional()
  @IsString()
  pageCover?: string;

  @IsOptional()
  @IsBoolean()
  isProfilePublic?: boolean;
}
