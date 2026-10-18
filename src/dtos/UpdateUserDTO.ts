import { IsEnum, IsOptional, IsString, IsNumber } from 'class-validator';
import { UserRole } from '../entities/User';

export class UpdateUserDTO {
  @IsOptional()
  @IsString()
  profileImage?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsString()
  walletAddress?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  rewardPoints?: number;
}
