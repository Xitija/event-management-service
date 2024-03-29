import { Module } from '@nestjs/common';
import { AttendeesController } from './attendees.controller';
import { AttendeesService } from './attendees.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventAttendees } from './entity/attendees.entity';
import { EventService } from '../event/event.service';
import { Events } from '../event/entities/event.entity';
import { EventModule } from '../event/event.module';


@Module({
  imports: [
    TypeOrmModule.forFeature([
      EventAttendees,
      Events
    ]),
    EventModule
  ],
  controllers: [AttendeesController],
  providers: [AttendeesService, ConfigService, EventService]
})
export class AttendeesModule { }
