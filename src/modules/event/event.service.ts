import {
  BadRequestException,
  HttpStatus,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { CreateEventDto, RecurrencePatternDto } from './dto/create-event.dto';
import { UpdateEventDto, UpdateResult } from './dto/update-event.dto';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  In,
  Not,
  MoreThan,
  MoreThanOrEqual,
  LessThanOrEqual,
  Between,
} from 'typeorm';
import { Events } from './entities/event.entity';
import e, { Response } from 'express';
import APIResponse from 'src/common/utils/response';
import { SearchFilterDto } from './dto/search-event.dto';
import { AttendeesService } from '../attendees/attendees.service';
import { EventAttendeesDTO } from '../attendees/dto/EventAttendance.dto';
import { EventDetail } from './entities/eventDetail.entity';
import { API_ID, ERROR_MESSAGES } from 'src/common/utils/constants.util';
import { EventRepetition } from './entities/eventRepetition.entity';
import {
  DaysOfWeek,
  EndConditionType,
  EventTypes,
  Frequency,
  RecurrencePattern,
  RepetitionDetail,
} from 'src/common/utils/types';
import { ConfigService } from '@nestjs/config';
import { DeleteResult, InsertResult } from 'typeorm';
import {
  DateValidationPipe,
  RecurringEndDateValidationPipe,
} from 'src/common/pipes/event-validation.pipe';
import { compareArrays, getNextDay } from 'src/common/utils/functions.util';

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
    response: Response,
  ): Promise<Response> {
    const apiId = API_ID.CREATE_EVENT;
    try {
      // this.validateCreateEventDto(createEventDto);
      // true for private, false for public
      let createdEvent: any = {};
      if (createEventDto.isRestricted === true) {
        // private event
        createdEvent = await this.createOfflineOrOnlineEvent(createEventDto);

        // if event is private then invitees are required
        // add invitees to attendees table

        // await this.attendeesService.createAttendeesForRecurringEvents(
        //   createEventDto.attendees,
        //   createdEvent.res.eventId,
        //   createdEvent.eventRepetitionIds,
        //   createEventDto.createdBy,
        // );

        // TODO: new approach of adding attendees
        // await this.attendeesService.createAttendeesForEvents(
        //   createEventDto.attendees,
        //   createdEvent.res.eventId,
        //   createEventDto.createdBy,
        // );
      } else {
        throw new NotImplementedException('Public events not implemented!');
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
        .json(APIResponse.success(apiId, createdEvent.res, 'Created'));
    } catch (error) {
      console.log(error, 'error create event');
      throw error;
    }
  }

  async getEvents(response, requestBody) {
    const apiId = API_ID.GET_EVENTS;
    try {
      const { filters } = requestBody;
      const today = new Date();

      let finalquery = `SELECT 
      er."eventDetailId" AS "eventRepetition_eventDetailId", 
      er."createdBy" AS "eventRepetition_createdBy",
      er.*, 
      e."eventId" AS "event_eventId", 
      e."eventDetailId" AS "event_eventDetailId",
      e.*, 
      ed."eventDetailId" AS "eventDetail_eventDetailId",
      ed.*, 
      COUNT(*) OVER() AS total_count
      FROM public."EventRepetition"  AS er
      LEFT JOIN "EventDetails" AS ed ON er."eventDetailId"=ed."eventDetailId" 
      LEFT JOIN "Events" AS e ON er."eventId"=e."eventId"`;

      //User not pass any things then it show today and upcoming event
      if (!filters || Object.keys(filters).length === 0) {
        finalquery += ` WHERE (er."startDateTime" >= CURRENT_TIMESTAMP
        OR er."endDateTime" > CURRENT_TIMESTAMP) AND ed.status='live'`;
      }

      // if user pass somthing in filter then make query
      if (filters && Object.keys(filters).length > 0) {
        finalquery = await this.createSearchQuery(filters, finalquery);
      }

      // Set default limit and offset if not provided
      const limit = requestBody.limit ? requestBody.limit : 200;
      const offset = requestBody.offset ? requestBody.offset : 0;

      // Append LIMIT and OFFSET to the query
      finalquery += ` LIMIT ${limit} OFFSET ${offset}`;

      const result = await this.eventRepetitionRepository.query(finalquery);
      const totalCount = result[0]?.total_count;

      // Add isEnded key based on endDateTime
      const finalResult = result.map((event) => {
        delete event.total_count;

        const endDateTime = new Date(event.endDateTime);
        return {
          ...event,
          isEnded: endDateTime < today,
        };
      });
      if (finalResult.length === 0) {
        throw new NotFoundException(ERROR_MESSAGES.EVENT_NOT_FOUND);
      }
      return response
        .status(HttpStatus.OK)
        .json(
          APIResponse.success(
            apiId,
            { totalCount, events: finalResult },
            'OK`',
          ),
        );
    } catch (error) {
      throw error;
    }
  }

  async createSearchQuery(filters, finalquery) {
    let whereClauses = [];

    // Handle specific date records
    if (filters?.date) {
      // const startDate = filters?.date;
      // const startDateTime = `${startDate} 00:00:00`;
      // const endDateTime = `${startDate} 23:59:59`;
      const startDateTime = filters?.date.after; // min date
      const endDateTime = filters?.date.before; // max date ---> seraching on the basis of max date
      whereClauses.push(
        `(er."startDateTime" <= '${endDateTime}'::timestamp AT TIME ZONE 'UTC' AND er."endDateTime" >= '${startDateTime}'::timestamp AT TIME ZONE 'UTC')`,
      );
    }

    // Handle startDate
    if (filters?.startDate && filters.endDate === undefined) {
      const startDate = filters?.startDate;
      // const startDateTime = `${startDate} 00:00:00`;
      // const endDateTime = `${startDate} 23:59:59`;
      const startDateTime = filters.startDate.after;
      const endDateTime = filters.startDate.before;

      whereClauses.push(
        `(er."startDateTime" <= '${endDateTime}' ::timestamp AT TIME ZONE 'UTC' AND er."startDateTime" >= '${startDateTime}' ::timestamp AT TIME ZONE 'UTC')`,
      );
    }

    if (filters?.startDate && filters.endDate) {
      const startDate = filters?.startDate;
      // const startDateTime = `${startDate} 00:00:00`;
      // const endDateTime = `${filters?.endDate} 23:59:59`;
      const startDateTime = filters.startDate.after; // 21 -> startDate
      const endDateTime = filters.endDate.before;

      whereClauses.push(
        `(er."startDateTime" <= '${endDateTime}' ::timestamp AT TIME ZONE 'UTC' AND er."endDateTime" >= '${startDateTime}' ::timestamp AT TIME ZONE 'UTC')`,
      );
    }

    if (filters.endDate && filters.startDate === undefined) {
      // const endDate = filters?.endDate;
      // const startDateTime = `${endDate} 00:00:00`;
      // const endDateTime = `${endDate} 23:59:59`;
      const startDateTime = filters.endDate.after;
      const endDateTime = filters.endDate.before;
      whereClauses.push(
        `(er."endDateTime" <= '${endDateTime}' ::timestamp AT TIME ZONE 'UTC' AND er."endDateTime" >= '${startDateTime}' ::timestamp AT TIME ZONE 'UTC')`,
      );
    }

    // Handle eventType filter
    if (filters.eventType && filters.eventType.length > 0) {
      const eventTypeConditions = filters.eventType
        .map((eventType) => `ed."eventType" = '${eventType}'`)
        .join(' OR ');
      whereClauses.push(`(${eventTypeConditions})`);
    }
    // Handle title filter with ILIKE
    if (filters.title) {
      const titleSearch = `%${filters.title}%`;
      whereClauses.push(`ed."title" ILIKE '${titleSearch}'`);
    }

    // Handle status filter
    if (filters?.status && filters?.status.length > 0) {
      const statusConditions = filters.status
        .map((status) => `ed."status" = '${status}'`)
        .join(' OR ');
      whereClauses.push(`(${statusConditions})`);
    } else {
      // Add default status condition if no status is passed in the filter
      whereClauses.push(`ed."status" = 'live'`);
    }

    // Handle cohortId filter
    if (filters?.cohortId) {
      whereClauses.push(`ed."metadata"->>'cohortId'='${filters.cohortId}'`);
    }

    if (filters?.createdBy) {
      whereClauses.push(`er."createdBy" = '${filters.createdBy}'`);
    }

    // Construct final query
    if (whereClauses.length > 0) {
      finalquery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    return finalquery;
  }

  async updateEvent(
    eventRepetitionId: string,
    updateBody: UpdateEventDto,
    response: Response,
  ) {
    const apiId = API_ID.UPDATE_EVENT;
    try {
      // Event repetition record must not be of passed date
      const currentTimestamp = new Date();
      // To do optimize both cases in one queries
      const eventRepetition = await this.eventRepetitionRepository.findOne({
        where: { eventRepetitionId, startDateTime: MoreThan(currentTimestamp) },
      });

      if (!eventRepetition) {
        // when id does not exist or event date is passed
        throw new BadRequestException(ERROR_MESSAGES.EVENT_NOT_FOUND);
      }
      const isEventArchived = await this.getEventDetails(
        eventRepetition.eventDetailId,
      );
      if (isEventArchived.status === 'archived') {
        throw new BadRequestException('Event is archived you can not Edit');
      }

      const event = await this.findEventById(eventRepetition.eventId);

      // condition for prevent non recuring event
      if (!event.isRecurring && !updateBody.isMainEvent) {
        throw new BadRequestException(
          'You can not pass isMainEvent false because event is non recurring',
          'You can not pass isMainEvent false because event is non recurring',
        );
      }

      const eventDetail = await this.getEventDetails(event.eventDetailId);

      const validationResult = this.isInvalidUpdate(updateBody, eventDetail);
      if (!validationResult.isValid) {
        throw new BadRequestException(validationResult.message);
      }
      let result;
      eventRepetition.updatedAt = new Date();
      eventRepetition.updatedBy = updateBody.updatedBy;
      if (updateBody?.isMainEvent) {
        // Handle updates or deletions for all recurrence records
        result = await this.handleAllEventUpdate(
          updateBody,
          event,
          eventDetail,
          eventRepetition,
        );
      } else {
        // Handle updates or deletions for a specific recurrence record
        result = await this.handleSpecificRecurrenceUpdate(
          updateBody,
          event,
          eventRepetition,
        );
      }
      return response
        .status(HttpStatus.OK)
        .json(APIResponse.success(apiId, result, 'OK'));
    } catch (error) {
      throw error;
    }
  }

  async updateRecurringEvents(
    newRecurrencePattern: RecurrencePatternDto,
    oldRecurrencePattern,
    currentEventRepetition,
  ) {
    if (newRecurrencePattern.frequency === Frequency.daily) {
      throw new NotImplementedException(
        'Daily frequency is not implemented yet',
      );
    }

    if (
      newRecurrencePattern.endCondition.type === EndConditionType.occurrences
    ) {
      // TODO: Implement end condition by occurrences
      throw new NotImplementedException(
        'End condition by occurrences is not implemented yet',
      );
    }

    const currentDate = new Date();
    const newRecurringStart = newRecurrencePattern.recurringStartDate;
    const newRecStartDate = new Date(newRecurringStart);

    const oldRecurringStart = oldRecurrencePattern.recurringStartDate;
    const oldRecStartDate = new Date(oldRecurringStart);

    const newRecurringEnd = newRecurrencePattern.endCondition.value;
    const oldRecurringEnd = oldRecurrencePattern.endCondition.value;
    const newRecEndDate = new Date(newRecurringEnd);
    const oldRecEndDate = new Date(oldRecurringEnd);

    if (newRecEndDate < currentDate) {
      throw new BadRequestException(
        'End Date cannot be changed because it is passed away',
      );
    }

    if (oldRecEndDate < currentDate) {
      throw new BadRequestException(
        'End Date cannot be changed because it is passed away',
      );
    }

    if (newRecStartDate > newRecEndDate) {
      // end date is passed is less than recurring start date
      throw new BadRequestException(
        'End date is passed is less than recurring start date',
      );
    }

    const isDateTimeUpdate = this.checkIfDateIsSame(
      newRecurrencePattern.recurringStartDate,
      oldRecurrencePattern.recurringStartDate,
      newRecurrencePattern.endCondition.value,
      oldRecurrencePattern.endCondition.value,
    );

    const isWeekPatternSame = this.checkIfPatternIsSame(
      newRecurrencePattern,
      oldRecurrencePattern,
    );

    if (!isDateTimeUpdate.dateSame || !isWeekPatternSame) {
      // date or pattern is different'
      if (isWeekPatternSame) {
        // new start date is passed
        // if (nstartDate !== ostartDate && oldRecStartDate < currentDate) {
        //   throw new BadRequestException(
        //     'Start Date cannot be changed because it is passed away',
        //   );
        // }

        // Pattern is same but date is different
        // either add or subtract events as pattern is same
        currentEventRepetition['recurrencePattern'] = oldRecurrencePattern;

        if (
          newRecStartDate.getTime() === oldRecStartDate.getTime() &&
          newRecEndDate.getTime() !== oldRecEndDate.getTime()
        ) {
          // start date and time is same
          // changed time of current event will take effect on following events
          // no action on start dates but end date is different

          // end date and time changed
          if (
            newRecEndDate.getTime() > oldRecEndDate.getTime() ||
            newRecEndDate.getTime() < oldRecEndDate.getTime()
          ) {
            // add or remove events and update end date in recpattern
            // and save current event with new time
            return await this.editThisAndFollowingEvents(
              currentEventRepetition,
              oldRecurrencePattern,
              newRecurrencePattern,
            );
          }
        }

        // find out if start date is changed or end date is changed or both are changed
        if (newRecStartDate < currentDate) {
          // not possible because cannot create events in past throw error
          // start date remains same
          throw new BadRequestException(
            'Cannot update events prepone not allowed for past events',
          );
        } else if (
          (newRecStartDate < oldRecStartDate &&
            newRecStartDate > currentDate) ||
          (newRecStartDate > oldRecStartDate && newRecStartDate > currentDate)
        ) {
          // prepone events when new start date lies between current date and old start date
          // end date remains same
          // add events fully and update start date in recpattern

          return await this.deleteOldAndRecreateNewEvents(
            currentEventRepetition,
            newRecurrencePattern,
          );
        }
      } else {
        // Pattern is different- date doesnt matter
        // Frequency and interval are different
        // make start date as end date for old events and create new events
        if (oldRecStartDate > currentDate) {
          // old start date is greater than current date that means event is in future
          // check newrecurrence startDate should be greater than currentDate

          if (newRecStartDate < currentDate) {
            throw new BadRequestException(
              'Recurrence start date must be in future',
            );
          }
          return await this.deleteOldAndRecreateNewEvents(
            currentEventRepetition,
            newRecurrencePattern,
          );
        } else {
          // old start date is less than current date that means event started in past

          return await this.editThisAndFollowingEvents(
            currentEventRepetition,
            oldRecurrencePattern,
            newRecurrencePattern,
          );
        }
      }
    } else if (
      !isDateTimeUpdate.timeSame &&
      isDateTimeUpdate.dateSame &&
      isWeekPatternSame
    ) {
      //  just time is different so just update time
      return await this.editThisAndFollowingEvents(
        currentEventRepetition,
        oldRecurrencePattern,
        newRecurrencePattern,
      );
    }
  }

  async createNewEventAndEventDetail(
    eventId,
    eventDetailId,
    newRecurrencePattern,
  ) {
    // Create new event and eventDetail as per details of orignal event
    const oldEvent = await this.findEventById(eventId);

    oldEvent.eventId = undefined; // so that new event is created and new id is generated for it
    oldEvent.createdAt = new Date();
    oldEvent.updatedAt = new Date();

    const oldEventDetail = await this.getEventDetails(eventDetailId);
    oldEventDetail.eventDetailId = undefined; // so that new eventDetail is created and new id is generated for it
    oldEventDetail.createdAt = new Date();
    oldEventDetail.updatedAt = new Date();

    const newEventDetail =
      await this.eventDetailRepository.save(oldEventDetail);
    oldEvent.eventDetailId = newEventDetail.eventDetailId;
    oldEvent.recurrencePattern = newRecurrencePattern;
    const newEvent = await this.eventRepository.save(oldEvent);

    return { newEvent, newEventDetail };
  }

  async updateEventRepetitionPattern(eventId, repetitionPattern) {
    return await this.eventRepository.update(
      {
        eventId,
      },
      {
        recurrencePattern: repetitionPattern,
        updatedAt: new Date(),
      },
    );
  }

  async deleteOldAndRecreateNewEvents(
    currentEventRepetition,
    newRecurrencePattern,
  ) {
    // delete old events associated with the eventId
    const removedEvents = await this.eventRepetitionRepository.delete({
      eventId: currentEventRepetition.eventId,
    });
    currentEventRepetition['recurrencePattern'] = newRecurrencePattern;
    currentEventRepetition['startDatetime'] =
      newRecurrencePattern.recurringStartDate;
    currentEventRepetition['endDatetime'] =
      currentEventRepetition['startDatetime'].split('T')[0] +
      'T' +
      currentEventRepetition.endDatetime.split('T')[1];

    currentEventRepetition.updatedAt = new Date();

    // create new events
    const newlyAddedEvents = await this.createRecurringEvents(
      currentEventRepetition,
      currentEventRepetition.eventId,
      currentEventRepetition.eventDetailId,
      true,
    );

    const extUpdt = await this.updateEventRepetitionPattern(
      currentEventRepetition.eventId,
      currentEventRepetition.recurrencePattern,
    );

    return {
      removedEvents,
      newlyAddedEvents,
      newEvent: currentEventRepetition.eventId,
      newEventDetail: currentEventRepetition.eventDetailId,
    };
  }

  async editThisAndFollowingEvents(
    currentEventRepetition,
    oldRecurrencePattern,
    newRecurrencePattern,
  ) {
    // remove upcoming events
    const removedEvents = await this.removeEventsMoreThanOrEqualToDate(
      currentEventRepetition.startDateTime,
      currentEventRepetition.eventId,
    );

    // update recurrence pattern in which update endDate so that old event ends on new start date
    // set start of new event as end of old event

    oldRecurrencePattern.endCondition.value =
      currentEventRepetition.startDatetime;

    const extUpdt = await this.updateEventRepetitionPattern(
      currentEventRepetition.eventId,
      oldRecurrencePattern,
    );

    newRecurrencePattern.recurringStartDate =
      currentEventRepetition.startDatetime;
    currentEventRepetition['recurrencePattern'] = newRecurrencePattern;

    currentEventRepetition['endDatetime'] =
      currentEventRepetition['startDatetime'].split('T')[0] +
      'T' +
      currentEventRepetition.endDatetime.split('T')[1];

    currentEventRepetition.updatedAt = new Date();

    const { newEvent, newEventDetail } =
      await this.createNewEventAndEventDetail(
        currentEventRepetition.eventId,
        currentEventRepetition.eventDetailId,
        newRecurrencePattern,
      );

    currentEventRepetition.eventId = newEvent.eventId;
    currentEventRepetition.eventDetailId = newEventDetail.eventDetailId;

    const newlyAddedEvents = await this.createRecurringEvents(
      currentEventRepetition,
      currentEventRepetition.eventId,
      currentEventRepetition.eventDetailId,
      true,
    );
    return {
      removedEvents,
      newlyAddedEvents,
      newEvent: newEvent,
      newEventDetail: newEventDetail,
    };
  }

  async updateEventRepetitionTime(
    fromDate,
    toDate,
    eventIds,
    newStartTime,
    newEndTime,
  ) {
    return await this.eventRepetitionRepository.update(
      {
        eventId: In(eventIds), // Filters by eventIds
        startDateTime: Between(fromDate, toDate), // Filters by startTime range
      },
      {
        // Update the time portion of startTime while keeping the date intact
        startDateTime: () =>
          `TO_TIMESTAMP(TO_CHAR(startDateTime, 'YYYY-MM-DD') || ' ${newStartTime}', 'YYYY-MM-DD HH24:MI:SS')`,
        endDateTime: () =>
          `TO_TIMESTAMP(TO_CHAR(endDateTime, 'YYYY-MM-DD') || ' ${newEndTime}', 'YYYY-MM-DD HH24:MI:SS')`,
      },
    );
  }

  async updateEventRepetition(recurrenceRecords: EventRepetition[], set) {
    return await this.eventRepetitionRepository.update(
      {
        eventRepetitionId: In(
          recurrenceRecords.map((record) => record.eventRepetitionId),
        ),
      },
      set,
    );
  }

  async removeEventsMoreThanOrEqualToDate(fromDate: Date, eventId: string) {
    const removedEvents = await this.eventRepetitionRepository.delete({
      eventId: eventId,
      startDateTime: MoreThanOrEqual(fromDate),
      // endDateTime: MoreThanOrEqual(toDate),
    });
    return removedEvents;
  }

  async removeEventsLessThanOrEqualToDate(fromDate: Date, eventId: string) {
    const removedEvents = await this.eventRepetitionRepository.delete({
      eventId: eventId,
      startDateTime: LessThanOrEqual(fromDate),
      // endDateTime: MoreThanOrEqual(toDate),
    });
    return removedEvents;
  }

  checkIfPatternIsSame(newRecurrencePattern, oldRecurrencePattern) {
    if (
      newRecurrencePattern.frequency === oldRecurrencePattern.frequency &&
      newRecurrencePattern.interval === oldRecurrencePattern.interval &&
      compareArrays(
        newRecurrencePattern.daysOfWeek,
        oldRecurrencePattern.daysOfWeek,
      )
    ) {
      return true;
    }
    return false;
  }

  checkIfDateIsSame(
    newRecurrenceStartDt: string,
    oldRecurrenceStartDt: string,
    newRecurrenceEndDt: string,
    oldRecurrenceEndDt: string,
  ) {
    const newStartRecDateTime = newRecurrenceStartDt.split('T');
    const oldStartRecDateTime = oldRecurrenceStartDt.split('T');
    const newEndRecDateTime = newRecurrenceEndDt.split('T');
    const oldEndRecDateTime = oldRecurrenceEndDt.split('T');

    const newRecStartDate = newStartRecDateTime[0];
    const oldRecStartDate = oldStartRecDateTime[0];
    const newRecEndDate = newEndRecDateTime[0];
    const oldRecEndDate = oldEndRecDateTime[0];
    const newRecStartTime = newStartRecDateTime[1];
    const oldRecStartTime = oldStartRecDateTime[1];
    const newRecEndTime = newEndRecDateTime[1];
    const oldRecEndTime = oldEndRecDateTime[1];

    if (
      newRecStartDate === oldRecStartDate &&
      newRecEndDate === oldRecEndDate
    ) {
      // start and end date same check if time is different
      if (
        newRecStartTime !== oldRecStartTime ||
        newRecEndTime !== oldRecEndTime
      ) {
        // time is different
        return {
          dateSame: true,
          timeSame: false,
        };
      } else {
        // date and time both same
        return {
          dateSame: true,
          timeSame: true,
        };
      }
    } else {
      // date is different
      return {
        dateSame: false,
        timeSame: false,
      };
    }
  }

  checkValidRecurrenceTimeForUpdate(endDate, recurrenceEndDate) {
    if (endDate.split('T')[1] !== recurrenceEndDate.split('T')[1]) {
      throw new BadRequestException(
        'Event End time does not match with Recurrence Start or End time',
      );
    }
  }

  async getRecurrenceRecords(eventId, eventRepetitionStartDateTime) {
    return await this.eventRepetitionRepository
      .createQueryBuilder('eventRepetition')
      .innerJoinAndSelect('eventRepetition.eventDetail', 'eventDetail')
      .where('eventRepetition.eventId = :eventId', { eventId })
      .andWhere('eventRepetition.startDateTime >= :startDateTime', {
        startDateTime: eventRepetitionStartDateTime,
      })
      .andWhere('eventRepetition.startDateTime >= :startDateTime', {
        startDateTime: eventRepetition.startDateTime,
      })
      .andWhere('eventDetail.status != :status', { status: 'archived' })
      .getMany();
  }

  async getUpcomingRecurrenceRecords(
    eventId,
    eventDetailId,
    eventRepetitionStartDateTime,
  ) {
    return await this.eventRepetitionRepository
      .createQueryBuilder('eventRepetition')
      .innerJoinAndSelect('eventRepetition.eventDetail', 'eventDetail')
      .where('eventRepetition.eventId = :eventId', { eventId })
      .andWhere('eventRepetition.eventDetailId != :eventDetailId', {
        eventDetailId,
      })
      .andWhere('eventRepetition.startDateTime >= :startDateTime', {
        startDateTime: eventRepetitionStartDateTime,
      })
      .andWhere('eventDetail.status != :status', { status: 'archived' })
      .orderBy('eventRepetition.startDateTime', 'ASC') // Sort by startDateTime in ascending order
      .getMany();
  }

  async handleAllEventUpdate(
    updateBody: UpdateEventDto,
    event: Events,
    eventDetail: EventDetail,
    eventRepetition: EventRepetition,
  ) {
    updateBody.isRecurring = event.isRecurring;
    const { startDatetime, endDatetime } = updateBody;

    // new updated time from current update body
    eventRepetition['startDatetime'] = startDatetime;
    eventRepetition['endDatetime'] = endDatetime;

    let updateResult;
    // : UpdateResult = {};
    let updatedEvents;
    let eventAndEventDetails;

    // Handle recurring events
    if (startDatetime && endDatetime && event.isRecurring) {
      const startDateTime = startDatetime.split('T');
      const endDateTime = endDatetime.split('T');
      const startDate = startDateTime[0];
      const endDate = endDateTime[0];

      const startDateAndTimeOfCurrentEvent = eventRepetition.startDateTime
        .toISOString()
        .split('T');

      const endDateAndTimeOfCurrentEvent = eventRepetition.endDateTime
        .toISOString()
        .split('T');

      const startDateOfCurrentEvent = startDateAndTimeOfCurrentEvent[0];
      const startTimeOfCurrentEvent = startDateAndTimeOfCurrentEvent[1];
      if (
        startDate !== startDateOfCurrentEvent ||
        endDate !== startDateOfCurrentEvent
      ) {
        throw new BadRequestException(
          'Invalid Date passed for this recurring event',
        );
      }

      if (event.recurrencePattern?.frequency && updateBody.recurrencePattern) {
        // undefined , past or equal to previously given date
        if (
          updateBody.recurrencePattern.recurringStartDate == undefined ||
          !new Date(updateBody.recurrencePattern.recurringStartDate)
        ) {
          // // no start date is passed , make old date as start date
          // updateBody.recurrencePattern.recurringStartDate =
          //   event.recurrencePattern.recurringStartDate;
          throw new BadRequestException(
            'Please Provide Valid Recurring Start Date',
          );
        }

        new DateValidationPipe().transform(updateBody);
        new RecurringEndDateValidationPipe().transform(updateBody);

        updatedEvents = await this.updateRecurringEvents(
          updateBody.recurrencePattern,
          event.recurrencePattern,
          eventRepetition,
        );
        // console.log('updatedEvents', updatedEvents);
      }
      if (updatedEvents) {
        if (
          !(updatedEvents.newEvent instanceof Events) &&
          updatedEvents.newEvent === event.eventId
        ) {
          eventAndEventDetails = {};
          eventAndEventDetails['newEvent'] = await this.findEventById(
            updatedEvents.newEvent,
          );
          eventAndEventDetails['newEventDetail'] = await this.getEventDetails(
            updatedEvents.newEventDetail,
          );
        }
        // else as passed from function
      } else {
        eventAndEventDetails = {};
        eventAndEventDetails['newEvent'] = event;
        eventAndEventDetails['newEventDetail'] = eventDetail;
      }
    } else if (startDatetime && endDatetime && !event.isRecurring) {
      // Handle non-recurring events
      new DateValidationPipe().transform(updateBody);
      eventRepetition.startDateTime = new Date(updateBody.startDatetime);
      eventRepetition.endDateTime = new Date(updateBody.endDatetime);
      eventRepetition.updatedAt = new Date();
      await this.eventRepetitionRepository.save(eventRepetition);
      updateResult.repetationDetail = eventRepetition;
    }

    // get current first event as we regenerate new events and make other changes first event might change
    const currentFirstEvent = await this.getFirstEvent(
      eventAndEventDetails.newEvent.eventId,
      new Date(
        eventAndEventDetails.newEvent.recurrencePattern.recurringStartDate,
      ), // updatedEvents.newEvent.recurrencePattern.recurringStartDate --- startDatetime
    );

    eventRepetition = currentFirstEvent;

    const recurrenceRecords = await this.getRecurrenceRecords(
      eventAndEventDetails.newEvent.eventId,
      eventRepetition.startDateTime,
    );

    // Handle onlineDetails or erMetaData updates for single recurring event
    if (updateBody.onlineDetails || updateBody.erMetaData) {
      const updateData: any = { updatedAt: new Date() };
      if (updateBody.onlineDetails) {
        Object.assign(eventRepetition.onlineDetails, updateBody.onlineDetails);
        updateData.onlineDetails = eventRepetition.onlineDetails;
        updateResult.onlineDetails = updateBody.onlineDetails;
      }

      if (updateBody.erMetaData) {
        Object.assign(eventRepetition.erMetaData, updateBody.erMetaData);
        updateData.erMetaData = eventRepetition.erMetaData;
        updateResult.erMetaData = updateBody.erMetaData;
      }
      updateResult['updatedRecurringEvent'] = await this.updateEventRepetition(
        recurrenceRecords,
        updateData,
      );
    }

    // Handle event detail updates
    if (
      updateBody.title ||
      updateBody.location ||
      updateBody.latitude ||
      updateBody.status ||
      updateBody.onlineDetails ||
      updateBody.metadata
    ) {
      updateResult = await this.updateEventDetailsForRecurringEvents(
        updateBody,
        recurrenceRecords,
        eventAndEventDetails.newEvent,
        eventAndEventDetails.newEventDetail,
        eventRepetition,
      );
    }
    return updateResult;
  }

  async updateEventDetailsForRecurringEvents(
    updateBody,
    recurrenceRecords: EventRepetition[],
    event: Events,
    eventDetail: EventDetail,
    eventRepetition,
  ) {
    let updateResult = {};

    // Get event which eventDetailId is diffrent from main eventDetailId from eventRepetation table[use for delete]
    const upcomingrecurrenceRecords = await this.getUpcomingRecurrenceRecords(
      event.eventId,
      eventDetail.eventDetailId,
      eventRepetition.startDateTime,
    );
    const existingEventDetails = eventDetail;

    if (updateBody.onlineDetails) {
      Object.assign(
        existingEventDetails.meetingDetails,
        updateBody.onlineDetails,
      );
    }
    if (updateBody.metadata) {
      Object.assign(existingEventDetails.metadata, updateBody.metadata);
    }

    // get first event
    const firstEvent: EventRepetition = recurrenceRecords[0];

    if (firstEvent.eventRepetitionId === eventRepetition.eventRepetitionId) {
      // Always true in case of non recurring
      Object.assign(existingEventDetails, updateBody, {
        eventRepetitionId: eventRepetition.eventRepetitionId,
      });
      existingEventDetails.updatedAt = new Date();
      const updatedEventDetails =
        await this.eventDetailRepository.save(existingEventDetails);
      // below code run for update of recurring event
      if (recurrenceRecords.length > 0) {
        const updateResult = await this.updateEventRepetition(
          recurrenceRecords,
          {
            eventDetailId: event.eventDetailId,
          },
        );
        updateResult['updatedEvents'] = updateResult.affected;
      }
      // delete eventDetail from eventDetail table if futher created single-single for upcoming session
      if (upcomingrecurrenceRecords.length > 0) {
        await this.deleteEventDetail(
          upcomingrecurrenceRecords.map((record) => record.eventDetailId),
        );
      }
      updateResult['eventDetails'] = updatedEventDetails;
    } else {
      // Not going in this condition if event is non recurring
      // create new entry for new updated record which connect all upcoming and this event
      if (eventRepetition.eventDetailId === event.eventDetailId) {
        Object.assign(existingEventDetails, updateBody);
        existingEventDetails.eventDetailId = undefined;
        const saveNewEntry =
          await this.eventDetailRepository.save(existingEventDetails);

        // update eventDetail id in all places which are greater than and equal to curreitn repetation startDate in repetation table
        if (recurrenceRecords.length > 0) {
          const updateResult = await this.updateEventRepetition(
            recurrenceRecords,
            {
              eventDetailId: saveNewEntry.eventDetailId,
            },
          );
          updateResult['updatedEvents'] = updateResult.affected;
        }
        // delete eventDetail from eventDetail table if futher created single-single for upcoming session
        if (upcomingrecurrenceRecords.length > 0) {
          await this.deleteEventDetail(
            upcomingrecurrenceRecords.map((record) => record.eventDetailId),
          );
        }
        updateResult['eventDetails'] = saveNewEntry;
      } else {
        // do change in existing eventDetail row [eventRepetition.eventDetails me] table
        const repetationeventDetailexistingResult = await this.getEventDetails(
          eventRepetition.eventDetailId,
        );

        let neweventDetailsId;
        const numberOfEntryInEventReperationTable =
          await this.getEventRepetitionOccurrences(
            eventRepetition.eventDetailId,
          );

        if (updateBody.onlineDetails) {
          Object.assign(
            repetationeventDetailexistingResult['meetingDetails'],
            updateBody.onlineDetails,
          );
        }
        if (numberOfEntryInEventReperationTable.length === 1) {
          Object.assign(repetationeventDetailexistingResult, updateBody, {
            eventRepetitionId: eventRepetition.eventRepetitionId,
          });

          const result = await this.eventDetailRepository.save(
            repetationeventDetailexistingResult,
          );
          neweventDetailsId = result.eventDetailId;
          updateResult['eventDetails'] = result;
        } else {
          // if greater than then create new entry in eventDetail Table
          Object.assign(repetationeventDetailexistingResult, updateBody, {
            eventRepetitionId: eventRepetition.eventRepetitionId,
          });
          repetationeventDetailexistingResult.eventDetailId = undefined;
          const result = await this.eventDetailRepository.save(
            repetationeventDetailexistingResult,
          );
          neweventDetailsId = result.eventDetailId;
          updateResult['eventDetails'] = result;
        }

        // update eventDetail id in all places which are greater than and equal to curreitn repetation startDate in repetation table
        if (recurrenceRecords.length > 0) {
          const updateResult = await this.updateEventRepetition(
            recurrenceRecords,
            {
              eventDetailId: neweventDetailsId,
            },
          );
          updateResult['updatedEvents'] = updateResult.affected;
        }
      }
    }

    return updateResult;
  }

  async handleSpecificRecurrenceUpdate(updateBody, event, eventRepetition) {
    let updateResult: UpdateResult = {};
    if (updateBody?.startDatetime && updateBody?.endDatetime) {
      new DateValidationPipe().transform(updateBody);
      eventRepetition.startDateTime = updateBody.startDatetime;
      eventRepetition.endDateTime = updateBody.endDatetime;
      eventRepetition.updatedAt = new Date();
      await this.eventRepetitionRepository.save(eventRepetition);
      updateResult.repetationDetail = eventRepetition;
    }
    const eventDetailId = eventRepetition.eventDetailId;
    const existingEventDetails = await this.getEventDetails(eventDetailId);

    existingEventDetails.updatedAt = new Date();

    if (
      updateBody.title ||
      updateBody.location ||
      updateBody.latitude ||
      updateBody.status ||
      updateBody.onlineDetails ||
      updateBody.metadata
    ) {
      if (updateBody.onlineDetails) {
        Object.assign(
          existingEventDetails.meetingDetails,
          updateBody.onlineDetails,
        );
      }

      if (event.eventDetailId === existingEventDetails.eventDetailId) {
        Object.assign(existingEventDetails, updateBody, {
          eventRepetitionId: eventRepetition.eventRepetitionId,
        });
        existingEventDetails.eventDetailId = undefined;

        const result =
          await this.eventDetailRepository.save(existingEventDetails);
        eventRepetition.eventDetailId = result.eventDetailId;
        eventRepetition.updatedAt = new Date();
        eventRepetition.updatedAt = new Date();
        await this.eventRepetitionRepository.save(eventRepetition);
        updateResult.eventDetails = result;
      } else {
        // check in event repetation table where existingEventDetails.eventDetailId aginst how many record exist
        const numberOfEntryInEventReperationTable =
          await this.getEventRepetitionOccurrences(
            existingEventDetails.eventDetailId,
          );

        if (numberOfEntryInEventReperationTable.length === 1) {
          Object.assign(existingEventDetails, updateBody, {
            eventRepetitionId: eventRepetition.eventRepetitionId,
          });
          const result =
            await this.eventDetailRepository.save(existingEventDetails);
          updateResult.eventDetails = result;
        } else {
          // if greater than then create new entry in eventDetail Table
          Object.assign(existingEventDetails, updateBody, {
            eventRepetitionId: eventRepetition.eventRepetitionId,
          });
          existingEventDetails.eventDetailId = undefined;
          const result =
            await this.eventDetailRepository.save(existingEventDetails);
          eventRepetition.eventDetailId = result.eventDetailId;
          eventRepetition.updatedAt = new Date();
          await this.eventRepetitionRepository.save(eventRepetition);
          updateResult.eventDetails = result;
        }
      }
    }
    if (updateBody.onlineDetails || updateBody.erMetaData) {
      if (updateBody.onlineDetails) {
        Object.assign(eventRepetition.onlineDetails, updateBody.onlineDetails);
        updateResult.onlineDetails = updateBody.onlineDetails;
      }
      if (updateBody.erMetaData) {
        Object.assign(eventRepetition.erMetaData, updateBody.erMetaData);
        updateResult.erMetaData = updateBody.erMetaData;
      }
      eventRepetition.updatedAt = new Date();
      await this.eventRepetitionRepository.save(eventRepetition);
    }
    return updateResult;
  }

  isInvalidUpdate(updateBody, eventDetail) {
    if (updateBody.location || (updateBody.latitude && updateBody.longitude)) {
      if (eventDetail.eventType === 'online') {
        return {
          isValid: false,
          message:
            'Cannot update location or lat or long details for an online event',
        };
      }
    }

    if (updateBody.onlineDetails) {
      if (eventDetail.eventType === 'offline') {
        return {
          isValid: false,
          message: 'Cannot update online details for an offline event',
        };
      }
    }

    return { isValid: true };
  }

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
    eventDetail.maxAttendees = createEventDto?.maxAttendees;
    eventDetail.recordings = createEventDto?.recordings;
    eventDetail.status = createEventDto.status;
    eventDetail.attendees = createEventDto?.attendees?.length
      ? createEventDto.attendees
      : null;
    eventDetail.meetingDetails = createEventDto.meetingDetails;
    eventDetail.idealTime = createEventDto?.idealTime
      ? createEventDto.idealTime
      : null;
    eventDetail.metadata = createEventDto?.metaData ?? {};
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

    if (recurrencePattern?.endCondition?.value) {
      recurrencePattern.recurringStartDate = createEventDto.startDatetime;
      recurrencePattern.daysOfWeek.sort((a, b) => a - b);
    }
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
    if (createEventDto.eventType === EventTypes.online) {
      eventRepetition.onlineDetails['occurenceId'] = '';
    }
    eventRepetition.startDateTime = new Date(createEventDto.startDatetime);
    eventRepetition.endDateTime = new Date(createEventDto.endDatetime);
    eventRepetition.createdBy = createEventDto.createdBy;
    eventRepetition.updatedBy = createEventDto.updatedBy;
    eventRepetition.erMetaData = createEventDto.erMetaData ?? {};
    eventRepetition.createdAt = new Date();
    eventRepetition.updatedAt = new Date();
    return this.eventRepetitionRepository.save(eventRepetition);
  }

  createRepetitionOccurence(
    createEventDto: CreateEventDto,
    eventDetailId: string,
    eventId: string,
    isEdit: boolean,
  ): EventRepetition {
    const eventRepetition = new EventRepetition();
    eventRepetition.eventDetailId = eventDetailId;
    eventRepetition.eventId = eventId;
    if (isEdit && createEventDto instanceof EventRepetition) {
      eventRepetition.createdBy = createEventDto.createdBy;
      eventRepetition.onlineDetails = createEventDto.onlineDetails;
      eventRepetition.erMetaData = createEventDto.erMetaData;
    } else {
      eventRepetition.onlineDetails = createEventDto.meetingDetails;
      eventRepetition.erMetaData = createEventDto.erMetaData ?? {};
    }
    if (createEventDto.eventType === EventTypes.online) {
      eventRepetition.onlineDetails['occurenceId'] = '';
    }
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

      const createdEventDetailDB =
        await this.createEventDetailDB(createEventDto);

      const createdEventDB = await this.createEventDB(
        createEventDto,
        createdEventDetailDB,
      );

      let erep: EventRepetition | InsertResult;

      if (createEventDto.isRecurring) {
        erep = await this.createRecurringEvents(
          createEventDto,
          createdEventDB.eventId,
          createdEventDetailDB.eventDetailId,
        );
        return {
          res: this.generateEventResponse(
            createdEventDB,
            erep?.generatedMaps[0],
            erep?.generatedMaps.length,
          ),
          eventRepetitionIds: erep.identifiers,
        };
      } else {
        // this.createNonRecurringEvent(createEventDto);
        erep = await this.createEventRepetitionDB(
          createEventDto,
          createdEventDB,
          createdEventDetailDB,
        );
        const { event, eventDetail, ...repetitionDtl } = erep;

        return {
          res: this.generateEventResponse(event, repetitionDtl),
          eventRepetitionIds: [{ eventRepetitionId: erep.eventRepetitionId }],
        };
      }

      // generate and return response body
    } catch (error) {
      console.log(error, 'error');
      throw error;
    }
  }

  async createRecurringEvents(
    createEventDto: CreateEventDto,
    eventId: string,
    eventDetailId: string,
    isEdit: boolean = false,
  ) {
    const eventOccurences = this.generateEventOccurences(
      createEventDto,
      eventDetailId,
      eventId,
      isEdit,
    );

    if (!(this.eventCreationLimit > 0)) {
      const errmsg = 'Event creation limit unavailable';
      await this.removePartiallyCreatedData(eventId, eventDetailId);
      throw new BadRequestException(errmsg);
    }

    if (eventOccurences.length > this.eventCreationLimit) {
      await this.removePartiallyCreatedData(eventId, eventDetailId);
      throw new BadRequestException('Event Creation Count exceeded');
    } else if (eventOccurences.length <= 0) {
      await this.removePartiallyCreatedData(eventId, eventDetailId);
      throw new BadRequestException('Event recurrence period insufficient');
    } else {
      const insertedOccurences = await this.eventRepetitionRepository
        .createQueryBuilder()
        .insert()
        .into('EventRepetition')
        .values(eventOccurences)
        .returning(['onlineDetails', 'erMetaData'])
        .execute();
      // const insertedOccurences =
      //   await this.eventRepetitionRepository.insert(eventOccurences);
      return insertedOccurences;
    }
  }

  generateEventResponse(
    event: Events,
    repetitionDtl: Partial<RepetitionDetail>,
    createdEventCount: number = 1,
  ) {
    const { eventDetail, ...other } = event;

    delete eventDetail.attendees;
    const repetitionDetail = {};
    repetitionDetail['eventRepetitionId'] = repetitionDtl.eventRepetitionId;
    repetitionDetail['startDateTime'] = repetitionDtl.startDateTime;
    repetitionDetail['endDateTime'] = repetitionDtl.endDateTime;
    repetitionDetail['onlineDetails'] = repetitionDtl.onlineDetails;
    repetitionDetail['erMetaData'] = repetitionDtl.erMetaData;

    const response = Object.assign(eventDetail, other, repetitionDetail, {
      createdEventCount,
    });

    return response;
  }

  async getEventRepetitionOccurrences(
    eventDetailId: string,
  ): Promise<EventRepetition[]> {
    return this.eventRepetitionRepository.find({ where: { eventDetailId } });
  }

  async getEventDetails(eventDetailId: string): Promise<EventDetail> {
    return this.eventDetailRepository.findOne({ where: { eventDetailId } });
  }

  async findEventById(eventId: string): Promise<Events> {
    return this.eventRepository.findOne({ where: { eventId } });
  }

  async getFirstEvent(
    eventId: string,
    eventRepetitionStartDateTime: Date,
  ): Promise<EventRepetition> {
    return await this.eventRepetitionRepository.findOne({
      where: {
        eventId,
        startDateTime: MoreThanOrEqual(eventRepetitionStartDateTime),
        eventDetail: {
          status: Not('archived'),
        },
      },
      relations: ['eventDetail'], // To replace `innerJoinAndSelect`
      order: {
        startDateTime: 'ASC', // Sort by startDateTime in ascending order
      },
    });
  }

  generateEventOccurences(
    createEventDto: CreateEventDto,
    eventDetailId: string,
    eventId: string,
    isEdit: boolean = false,
  ) {
    const config = createEventDto.recurrencePattern;
    const startDate = createEventDto.startDatetime;

    const occurrences: EventRepetition[] = [];
    const startTime = createEventDto.startDatetime.split('T')[1];
    const endTime = createEventDto.endDatetime.split('T')[1];

    let currentDate = new Date(startDate.split('T')[0] + 'T' + startTime);

    let createFirst = true;

    const addDays = (date: Date, days: number): Date => {
      const result = new Date(date);
      result.setDate(result.getDate() + days);
      return result;
    };

    const getNextValidDay = (
      currentDay: number,
      daysOfWeek: DaysOfWeek[],
    ): number => {
      //  [  0, 1, 2, 3,  4, 5, 6]
      console.log(
        currentDay,
        // daysOfWeek,
        // daysOfWeek.length,
        'CURRENTDAY',
        // 'daysOfWeek',
      );
      for (let i = 0; i < daysOfWeek.length; i++) {
        // console.log(daysOfWeek[i] >= currentDay, '===============', i);

        console.log(daysOfWeek[i], currentDay, 'daysOfWeek[i] - currentDay', i);
        if (daysOfWeek[i] > currentDay) {
          console.log(
            daysOfWeek[i] > currentDay,
            'daysOfWeek[i] > currentDay',
            i,
          );
          console.log(
            daysOfWeek[i] - currentDay > 0,
            daysOfWeek[i] - currentDay,
            'is greater than 0',
          );
          return daysOfWeek[i] - currentDay;
        }
      }
      console.log(
        7 - currentDay + daysOfWeek[0],
        '7 - currentDay + daysOfWeek[0] last',
      );
      return 7 - currentDay + daysOfWeek[0]; // Move to the next valid week
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
      } else if (endCondition.type === EndConditionType.occurrences) {
        return occurrences1.length >= parseInt(endCondition.value);
      }
      return false;
    };

    while (!endConditionMet(config.endCondition, occurrences)) {
      const eventRec = this.createRepetitionOccurence(
        createEventDto,
        eventDetailId,
        eventId,
        isEdit,
      );

      const currentDay = currentDate.getDay();

      // Check if the current day is a valid day in the recurrence pattern
      if (
        config.frequency === 'weekly' &&
        config.daysOfWeek.includes(currentDay) &&
        createFirst
      ) {
        const eventRec = this.createRepetitionOccurence(
          createEventDto,
          eventDetailId,
          eventId,
          isEdit,
        );
        const endDtm = currentDate.toISOString().split('T')[0] + 'T' + endTime;

        eventRec.startDateTime = new Date(currentDate);
        eventRec.endDateTime = new Date(endDtm);
        occurrences.push(eventRec);
      }

      if (config.frequency === Frequency.daily) {
        const endDtm = currentDate.toISOString().split('T')[0] + 'T' + endTime;

        eventRec.startDateTime = new Date(currentDate);
        eventRec.endDateTime = new Date(endDtm);
        occurrences.push(eventRec);
        currentDate = addDays(currentDate, config.interval);
      } else if (config.frequency === Frequency.weekly) {
        createFirst = false;
        const currentDay = currentDate.getDay();
        const daysUntilNextOccurrence = getNextValidDay(
          currentDay,
          config.daysOfWeek,
        );
        currentDate = addDays(currentDate, daysUntilNextOccurrence);
        const endDtm = currentDate.toISOString().split('T')[0] + 'T' + endTime;

        eventRec.startDateTime = new Date(currentDate);
        eventRec.endDateTime = new Date(endDtm);
        occurrences.push(eventRec);
        if (
          currentDate.getDay() ===
          config.daysOfWeek[config.daysOfWeek.length - 1]
        ) {
          currentDate = addDays(currentDate, 7 * (config.interval - 1)); // Skip weeks based on interval
        }
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

  async deleteEventDetail(eventDetailIds: string[]): Promise<DeleteResult> {
    return this.eventDetailRepository.delete({
      eventDetailId: In(eventDetailIds),
    });
  }

  async removePartiallyCreatedData(
    eventId: string,
    eventDetailId: string,
  ): Promise<PromiseSettledResult<undefined | DeleteResult>[]> {
    const promises = [
      this.deleteEvent(eventId),
      this.deleteEventDetail([eventDetailId]),
    ];

    const responses = await Promise.allSettled(promises);
    return responses;
  }
}
