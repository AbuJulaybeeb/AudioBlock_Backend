import { IsEnum, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { CollaboratorRole } from '../entities/SongCollaborator';

export class UpdateCollaboratorDTO {
  @IsOptional()
  @IsEnum(CollaboratorRole, { message: 'role must be a valid collaborator role.' })
  role?: CollaboratorRole;

  @IsOptional()
  @IsNumber()
  @Min(0.01, { message: 'royaltyShare must be greater than 0.' })
  @Max(100, { message: 'royaltyShare cannot exceed 100.' })
  royaltyShare?: number;
}
