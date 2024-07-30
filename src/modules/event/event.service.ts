import {
  BadRequestException,
  HttpStatus,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Events } from './entities/event.entity';
import { Response } from 'express';
import APIResponse from 'src/common/utils/response';
import { SearchFilterDto } from './dto/search-event.dto';
import { AttendeesService } from '../attendees/attendees.service';
import { EventAttendeesDTO } from '../attendees/dto/EventAttendance.dto';
import { EventDetail } from './entities/eventDetail.entity';
import { ERROR_MESSAGES } from 'src/common/utils/constants.util';
import { EventRepetition } from './entities/eventRepetition.entity';
import { EventTypes, RecurrencePattern } from 'src/common/utils/types';
import { ConfigService } from '@nestjs/config';
import { DeleteResult } from 'typeorm';
@Injectable()
export class EventService {
  private eventCreationLimit: number;

  constructor(
    @InjectRepository(Events)
    private readonly eventRepository: Repository<Events>,
    @InjectRepository(EventDetail)
    private readonly eventDetailRepository: Repository<EventDetail>,
    @InjectRepository(EventRepetition)
    private readonly eventRepetitionRepository: Repository<EventRepetition>,
    private readonly attendeesService: AttendeesService,
    private readonly configService: ConfigService,
  ) {
    this.eventCreationLimit = this.configService.get<number>(
      'EVENT_CREATION_LIMIT',
    );
  }

  async createEvent(
    createEventDto: CreateEventDto,
    userId: string,
    response: Response,
  ): Promise<Response> {
    const apiId = 'api.create.event';
    try {
      // this.validateCreateEventDto(createEventDto);
      // true for private, false for public
      let createdEvent: any = {};
      if (createEventDto.isRestricted === true) {
        // private event
        createdEvent = await this.createOfflineOrOnlineEvent(createEventDto);
        // if (createEventDto.eventType === 'online') {
        //   // create online event
        //   createdEvent = await this.createOnlineEvent(createEventDto);
        // } else if (createEventDto.eventType === 'offline') {
        //   // create offline event
        //   createdEvent = await this.createOfflineEvent(createEventDto);
        // }

        // if event is private then invitees are required
        // add invitees to attendees table
        // this.attendeesService;
      } else {
        throw new NotImplementedException();
        // if event is public then registrationDate is required
        if (createEventDto.eventType === 'online') {
          // create online event
          // this.createOnlineEvent(createEventDto);
        } else if (createEventDto.eventType === 'offline') {
          // create offline event
          // this.createOfflineEvent(createEventDto);
        }
      }

      return response
        .status(HttpStatus.CREATED)
        .json(APIResponse.success(apiId, createdEvent, 'Created'));
    } catch (error) {
      console.log(error, 'error create event');
      throw error;
    }
  }

  async createEvents(createEventDto, response) {}

  async createEventDetailDB(
    createEventDto: CreateEventDto,
  ): Promise<EventDetail> {
    const eventDetail = new EventDetail();
    eventDetail.title = createEventDto.title;
    eventDetail.description = createEventDto.description;
    eventDetail.shortDescription = createEventDto.shortDescription;
    eventDetail.eventType = createEventDto.eventType;
    eventDetail.isRestricted = createEventDto.isRestricted;
    eventDetail.location = createEventDto.location;
    eventDetail.longitude = createEventDto.longitude;
    eventDetail.latitude = createEventDto.latitude;
    eventDetail.onlineProvider = createEventDto.onlineProvider;
    eventDetail.maxAttendees = createEventDto.maxAttendees;
    eventDetail.recordings = createEventDto.recordings;
    eventDetail.status = createEventDto.status;
    eventDetail.attendees = createEventDto.attendees.length
      ? createEventDto.attendees
      : null;
    eventDetail.meetingDetails = createEventDto.meetingDetails;
    eventDetail.idealTime = createEventDto.idealTime;
    eventDetail.metadata = createEventDto.metaData;
    eventDetail.createdBy = createEventDto.createdBy;
    eventDetail.updatedBy = createEventDto.updatedBy;
    eventDetail.createdAt = new Date();
    eventDetail.updatedAt = new Date();

    return this.eventDetailRepository.save(eventDetail);
  }

  async createEventDB(
    createEventDto: CreateEventDto,
    eventDetail: EventDetail,
  ) {
    const {
      isRecurring,
      recurrencePattern,
      registrationStartDate,
      registrationEndDate,
    } = createEventDto;
    const event = new Events();

    event.isRecurring = isRecurring;
    // event.recurrenceEndDate = recurrenceEndDate
    //   ? new Date(recurrenceEndDate)
    //   : null;
    event.recurrencePattern = recurrencePattern ?? {};
    event.createdAt = new Date();
    event.updatedAt = new Date();
    event.autoEnroll = createEventDto.autoEnroll;
    event.registrationStartDate = registrationStartDate
      ? new Date(registrationStartDate)
      : null;
    event.registrationEndDate = registrationEndDate
      ? new Date(registrationEndDate)
      : null;
    event.createdBy = createEventDto.createdBy;
    event.updatedBy = createEventDto.updatedBy;
    event.eventDetail = eventDetail;

    return this.eventRepository.save(event);
  }

  async createEventRepetitionDB(
    createEventDto: CreateEventDto,
    event: Events,
    eventDetail: EventDetail,
  ) {
    const eventRepetition = new EventRepetition();
    eventRepetition.event = event;
    eventRepetition.eventDetail = eventDetail;
    eventRepetition.onlineDetails = createEventDto.meetingDetails;
    eventRepetition.startDateTime = new Date(createEventDto.startDatetime);
    eventRepetition.endDateTime = new Date(createEventDto.endDatetime);
    eventRepetition.createdBy = createEventDto.createdBy;
    eventRepetition.updatedBy = createEventDto.updatedBy;
    eventRepetition.createdAt = new Date();
    eventRepetition.updatedAt = new Date();
    return this.eventRepetitionRepository.save(eventRepetition);
  }

  createRepetitionOccurence(
    createEventDto: CreateEventDto,
    eventDetailId: string,
    eventId: string,
  ): EventRepetition {
    const eventRepetition = new EventRepetition();
    eventRepetition.eventDetailId = eventDetailId;
    eventRepetition.eventId = eventId;
    eventRepetition.onlineDetails = createEventDto.meetingDetails;
    eventRepetition.startDateTime = null;
    eventRepetition.endDateTime = null;
    eventRepetition.createdBy = createEventDto.createdBy;
    eventRepetition.updatedBy = createEventDto.updatedBy;
    eventRepetition.createdAt = new Date();
    eventRepetition.updatedAt = new Date();

    return eventRepetition;
  }

  async createOfflineOrOnlineEvent(createEventDto: CreateEventDto) {
    // recurring & non-recurring
    try {
      if (createEventDto.eventType === EventTypes.offline) {
        // create offline event
        createEventDto.onlineProvider = null;
        createEventDto.meetingDetails = null;
        createEventDto.recordings = null;
      } else if (createEventDto.eventType === EventTypes.online) {
        createEventDto.meetingDetails.providerGenerated = false;
      }

      const eventDetail = await this.createEventDetailDB(createEventDto);

      const event = await this.createEventDB(createEventDto, eventDetail);

      if (createEventDto.isRecurring) {
        const erep = await this.createRecurringEvents(
          createEventDto,
          event.eventId,
          eventDetail.eventDetailId,
        );

        return erep?.generatedMaps;
      } else {
        // this.createNonRecurringEvent(createEventDto);
        const erep = await this.createEventRepetitionDB(
          createEventDto,
          event,
          eventDetail,
        );
        return erep;
      }
    } catch (error) {
      console.log(error, 'error');
      throw error;
    }
  }

  async createRecurringEvents(
    createEventDto: CreateEventDto,
    eventId: string,
    eventDetailId: string,
  ) {
    // const eventOccurrences = this.generateEventOccurrences(createEventDto);
    // eventOccurrences.forEach((eventOccurrence) => {
    //   // Save event occurrence
    //   this.eventOccurrenceRepository.save(eventOccurrence);
    // });
    const eventOccurences = this.generateEventOccurences(
      createEventDto,
      eventDetailId,
      eventId,
    );

    console.log(
      eventOccurences,
      eventOccurences.length,
      'eventOccurences.length',
      eventOccurences.length <= 0 ||
        eventOccurences.length > this.eventCreationLimit,
    );
    if (
      eventOccurences.length <= 0 ||
      eventOccurences.length > this.eventCreationLimit
    ) {
      await this.removePartiallyCreatedData(eventId, eventDetailId);
      throw new BadRequestException('Event Creation Count exceeded');
    } else {
      const insertedOccurences =
        await this.eventRepetitionRepository.insert(eventOccurences);
      return insertedOccurences;
    }
  }

  createNonRecurringEvent(createEventDto: CreateEventDto) {}

  async getEventOccurrences(eventId: string): Promise<EventRepetition[]> {
    return this.eventRepetitionRepository.find({ where: { eventId: eventId } });
  }
  // async getEventOccurrences(eventId: string): Promise<EventOccurrence[]> {
  //   return this.eventOccurrenceRepository.find({ where: { event: eventId } });
  // }

  generateEventOccurences(
    createEventDto: CreateEventDto,
    eventDetailId: string,
    eventId: string,
  ) {
    const config = createEventDto.recurrencePattern;
    const startDate = createEventDto.startDatetime;

    const occurrences: EventRepetition[] = [];
    const startTime = createEventDto.startDatetime.split('T')[1];
    const endTime = createEventDto.endDatetime.split('T')[1];
    // let currentDate = new Date(startDate);

    let currentDate = new Date(startDate.split('T')[0] + 'T' + startTime);

    const addDays = (date, days) => {
      const result = new Date(date);
      result.setDate(result.getDate() + days);
      return result;
    };

    const addWeeks = (date, weeks, daysOfWeek) => {
      const result = new Date(date);
      const nextValidDay = daysOfWeek.find((day) => day > result.getDay());
      result.setDate(
        result.getDate() +
          (nextValidDay !== undefined
            ? nextValidDay - result.getDay()
            : 7 * weeks - result.getDay() + daysOfWeek[0]),
      );
      return result;
    };

    const endConditionMet = (
      endCondition: RecurrencePattern['endCondition'],
      occurrences1: EventRepetition[],
    ) => {
      if (endCondition.type === 'endDate') {
        return (
          occurrences1[occurrences1.length - 1]?.endDateTime >
          new Date(endCondition.value)
        );
      } else if (endCondition.type === 'occurrences') {
        return occurrences1.length >= parseInt(endCondition.value);
      }
      return false;
    };

    while (!endConditionMet(config.endCondition, occurrences)) {
      const eventRec = this.createRepetitionOccurence(
        createEventDto,
        eventDetailId,
        eventId,
      );

      const endDtm = currentDate.toISOString().split('T')[0] + 'T' + endTime;

      eventRec.startDateTime = new Date(currentDate);
      eventRec.endDateTime = new Date(endDtm);

      occurrences.push(eventRec);

      if (config.frequency === 'daily') {
        currentDate = addDays(currentDate, config.interval);
      } else if (config.frequency === 'weekly') {
        currentDate = addWeeks(currentDate, config.interval, config.daysOfWeek);
      }
    }

    // Remove the last occurrence if it exceeds the end date condition

    if (
      config.endCondition.type === 'endDate' &&
      occurrences[occurrences.length - 1]?.endDateTime >
        new Date(config.endCondition.value)
    ) {
      occurrences.pop();
    }

    return occurrences;
  }

  async deleteEvent(eventId: string): Promise<DeleteResult> {
    return this.eventRepository.delete({ eventId });
  }

  async deleteEventDetail(eventDetailId: string): Promise<DeleteResult> {
    return this.eventDetailRepository.delete({ eventDetailId });
  }

  async removePartiallyCreatedData(
    eventId: string,
    eventDetailId: string,
  ): Promise<PromiseSettledResult<void | DeleteResult>[]> {
    const promises = [
      this.deleteEvent(eventId),
      this.deleteEventDetail(eventDetailId),
    ];

    const responses = await Promise.allSettled(promises);
    return responses;
  }
}
