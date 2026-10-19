import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './User';

export type DevicePlatform = 'ios' | 'android' | 'web';

@Entity('device_tokens')
@Unique(['userId', 'token'])
@Index(['userId'])
export class DeviceToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column('text')
  token!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'web',
  })
  platform!: DevicePlatform | string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
