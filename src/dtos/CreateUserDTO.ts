// src/dtos/CreateUserDto.ts
import { IsEmail, IsEnum, IsOptional, IsString, IsNumber, IsNotEmpty } from 'class-validator';
import { UserRole } from '../entities/User';

export class CreateUserDTO {
  @IsOptional()
  @IsString()
  profileImage?: string;

  @IsString()
  @IsNotEmpty({ message: 'Artist name is required.' })
  dynamixUserId!: string;

  @IsEnum(UserRole)
  @IsNotEmpty({ message: 'Role is required.' })
  role!: UserRole;

  @IsString()
  @IsNotEmpty({ message: 'Wallet address is required.' })
  walletAddress!: string;

  @IsString()
  @IsOptional()
  username?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsNumber()
  rewardPoints?: number;

  @IsString()
  signature!: string;

  @IsString()
  message!: string;
}
