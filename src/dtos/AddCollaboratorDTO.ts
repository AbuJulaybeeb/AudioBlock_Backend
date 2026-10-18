import { IsEnum, IsNumber, IsUUID, Max, Min } from 'class-validator';
import { CollaboratorRole } from '../entities/SongCollaborator';

export class AddCollaboratorDTO {
  @IsUUID('4', { message: 'userId must be a valid user id.' })
  userId!: string;

  @IsEnum(CollaboratorRole, { message: 'role must be a valid collaborator role.' })
  role!: CollaboratorRole;

  @IsNumber()
  @Min(0.01, { message: 'royaltyShare must be greater than 0.' })
  @Max(100, { message: 'royaltyShare cannot exceed 100.' })
  royaltyShare!: number;
}
