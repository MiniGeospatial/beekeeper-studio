
// Copyright (c) 2015 The SQLECTRON Team 
import { readFileSync } from 'fs';

import pg, { QueryResult, PoolConfig, PoolClient } from 'pg';
import { identify } from 'sql-query-identifier';
import _  from 'lodash'
import knexlib from 'knex'
import logRaw from 'electron-log'

import { DatabaseElement, IDbConnectionServer, IDbConnectionDatabase } from '../types'
import { FilterOptions, OrderBy, TableFilter, TableUpdateResult, TableResult, Routine, TableChanges, TableInsert, TableUpdate, TableDelete, DatabaseFilterOptions, SchemaFilterOptions, NgQueryResult, StreamResults, ExtendedTableColumn, PrimaryKeyColumn, TableIndex, IndexedColumn, CancelableQuery, SupportedFeatures, TableColumn, TableOrView, TableProperties, TableTrigger, TablePartition, } from "../models";
import { buildDatabaseFilter, buildDeleteQueries, buildInsertQueries, buildSchemaFilter, buildSelectQueriesFromUpdates, buildUpdateQueries, escapeString, applyChangesSql } from './utils';
import { createCancelablePromise, joinFilters } from '../../../common/utils';
import { errors } from '../../errors';
import globals from '../../../common/globals';
import { HasPool, VersionInfo, HasConnection } from './postgresql/types'
import { PsqlCursor } from './postgresql/PsqlCursor';
import { PostgresqlChangeBuilder } from '@shared/lib/sql/change_builder/PostgresqlChangeBuilder';
import { AlterPartitionsSpec, TableKey } from '@shared/lib/dialects/models';
import { PostgresData } from '@shared/lib/dialects/postgresql';
import { BasicDatabaseClient, ExecutionContext, QueryLogOptions } from './BasicDatabaseClient';
import { ChangeBuilderBase } from '@shared/lib/sql/change_builder/ChangeBuilderBase';
import { defaultCreateScript, postgres10CreateScript } from './postgresql/scripts';


const base64 = require('base64-url'); // eslint-disable-line
const PD = PostgresData
function isConnection(x: any): x is HasConnection {
  return x.connection !== undefined
}

const log = logRaw.scope('postgresql')
const logger = () => log

const knex = knexlib({ client: 'pg'})

const pgErrors = {
  CANCELED: '57014',
};

const dataTypes: any = {}

export interface STQOptions {
  table: string,
  orderBy?: OrderBy[],
  filters?: TableFilter[] | string,
  offset?: number,
  limit?: number,
  schema: string,
  version: VersionInfo
  forceSlow?: boolean,
  selects?: string[],
  inlineParams?: boolean
}

interface STQResults {
  query: string,
  countQuery: string,
  params: (string | string[])[],

}

const postgresContext = {
  getExecutionContext(): ExecutionContext {
    return null;
  },
  logQuery(_query: string, _options: QueryLogOptions, _context: ExecutionContext): Promise<number | string> {
    return null;
  }
};

export class PostgresClient extends BasicDatabaseClient<QueryResult> {
  version: VersionInfo;
  conn: HasPool;
  runWithConnection: HasConnection;
  _defaultSchema: string;
  dataTypes: any;
  server: IDbConnectionServer;
  database: IDbConnectionDatabase;
  
  constructor(server: IDbConnectionServer, database: IDbConnectionDatabase) {
    super(knex, postgresContext);

    this.server = server;
    this.database = database;
  }

  versionString(): string {
    return this.version.version.split(" on ")[0];
  }

  getBuilder(table: string, schema: string = this._defaultSchema): ChangeBuilderBase {
    return new PostgresqlChangeBuilder(table, schema);
  }

  supportedFeatures(): SupportedFeatures {
    const hasPartitions = this.version.number >= 100000;
    return {
      customRoutines: true,
      comments: true,
      properties: true,
      partitions: hasPartitions,
      editPartitions: hasPartitions
    };
  }

  async connect(): Promise<void> {
    // For tests
    if (!this.server && !this.database) {
      return;
    }
    const dbConfig = await this.configDatabase(this.server, this.database);

    this.conn = {
      pool: new pg.Pool(dbConfig)
    };

    logger().debug('connected');
    this._defaultSchema = await this.getSchema();
    this.version = await this.getVersion();
    this.dataTypes = await this.getTypes();
  }

  async disconnect(): Promise<void> {
    this.conn.pool.end();
  }

  async listTables(_db: string, filter?: FilterOptions): Promise<TableOrView[]> {
    const schemaFilter = buildSchemaFilter(filter, 'table_schema');

    let sql = `
      SELECT
        t.table_schema as schema,
        t.table_name as name,
    `;

    if (this.version.hasPartitions) {
      sql += `
          pc.relkind as tabletype,
          parent_pc.relkind as parenttype
        FROM information_schema.tables AS t
        JOIN pg_class AS pc
          ON t.table_name = pc.relname AND quote_ident(t.table_schema) = pc.relnamespace::regnamespace::text
        LEFT OUTER JOIN pg_inherits AS i
          ON pc.oid = i.inhrelid
        LEFT OUTER JOIN pg_class AS parent_pc
          ON parent_pc.oid = i.inhparent
        WHERE t.table_type NOT LIKE '%VIEW%'
      `;
    } else {
      sql += `
          'r' AS tabletype,
          'r' AS parenttype
        FROM information_schema.tables AS t
        WHERE t.table_type NOT LIKE '%VIEW%'
      `;
    }

    sql += `
      ${schemaFilter ? `AND ${schemaFilter}` : ''}
      ORDER BY t.table_schema, t.table_name
    `;

    const data = await this.driverExecuteSingle(sql);

    return data.rows;
  }

  async listTablePartitions(table: string, schema: string = this._defaultSchema): Promise<TablePartition[]> {
    if (!this.version.hasPartitions) return null;

    const sql = this.knex.raw(`
        SELECT
          ps.schemaname AS schema,
          ps.relname AS name,
          pg_get_expr(pt.relpartbound, pt.oid, true) AS expression
        FROM pg_class base_tb
          JOIN pg_inherits i              ON i.inhparent = base_tb.oid
          JOIN pg_class pt                ON pt.oid = i.inhrelid
          JOIN pg_stat_all_tables ps      ON ps.relid = i.inhrelid
          JOIN pg_namespace nmsp_parent   ON nmsp_parent.oid = base_tb.relnamespace
        WHERE nmsp_parent.nspname = ? AND base_tb.relname = ? AND base_tb.relkind = 'p';
      `, [schema, table]).toQuery();

    const data = await this.driverExecuteSingle(sql);
    return data.rows;
  }

  async listViews(filter: FilterOptions = { schema: 'public' }): Promise<TableOrView[]> {
    const schemaFilter = buildSchemaFilter(filter, 'table_schema');
    const sql = `
      SELECT
        table_schema as schema,
        table_name as name
      FROM information_schema.views
      ${schemaFilter ? `WHERE ${schemaFilter}` : ''}
      ORDER BY table_schema, table_name
    `;

    const data = await this.driverExecuteSingle(sql);

    return data.rows;
  }

  async listRoutines(filter?: FilterOptions): Promise<Routine[]> {
    const schemaFilter = buildSchemaFilter(filter, 'r.routine_schema');
    const sql = `
      SELECT
        r.specific_name as id,
        r.routine_schema as routine_schema,
        r.routine_name as name,
        r.routine_type as routine_type,
        r.data_type as data_type
      FROM INFORMATION_SCHEMA.ROUTINES r
      where r.routine_schema not in ('sys', 'information_schema',
                                  'pg_catalog', 'performance_schema')
      ${schemaFilter ? `AND ${schemaFilter}` : ''}
      ORDER BY routine_schema, routine_name
    `;

    const paramsSQL = `
      select
          r.routine_schema as routine_schema,
          r.specific_name as specific_name,
          p.parameter_name as parameter_name,
          p.character_maximum_length as char_length,
          p.data_type as data_type
    from information_schema.routines r
    left join information_schema.parameters p
              on p.specific_schema = r.routine_schema
              and p.specific_name = r.specific_name
    where r.routine_schema not in ('sys', 'information_schema',
                                  'pg_catalog', 'performance_schema')
      ${schemaFilter ? `AND ${schemaFilter}` : ''}

        AND p.parameter_mode = 'IN'
    order by r.routine_schema,
            r.specific_name,
            p.ordinal_position;

    `

    const data = await this.driverExecuteSingle(sql);
    const paramsData = await this.driverExecuteSingle(paramsSQL);
    const grouped = _.groupBy(paramsData.rows, 'specific_name');

    return data.rows.map((row) => {
      const params = grouped[row.id] || [];
      return {
        schema: row.routine_schema,
        name: row.name,
        type: row.routine_type ? row.routine_type.toLowerCase() : 'function',
        returnType: row.data_type,
        entityType: 'routine',
        id: row.id,
        routineParams: params.map((p, i) => {
          return {
            name: p.parameter_name || `arg${i+1}`,
            type: p.data_type,
            length: p.char_length || undefined
          };
        })
      };
    });
  }
  async listMaterializedViewColumns(_db: string, table: string, schema: string = this._defaultSchema): Promise<TableColumn[]> {
    const clause = table ? `AND s.nspname = $1 AND t.relname = $2` : '';
    if (table && !schema) {
      throw new Error("Cannot get columns for '${table}, no schema provided'")
    }
    const sql = `
      SELECT s.nspname, t.relname, a.attname,
            pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
            a.attnotnull
      FROM pg_attribute a
        JOIN pg_class t on a.attrelid = t.oid
        JOIN pg_namespace s on t.relnamespace = s.oid
      WHERE a.attnum > 0
        AND NOT a.attisdropped
        ${clause}
      ORDER BY a.attnum;
    `;
    const params = table ? [schema, table] : [];
    const data = await this.driverExecuteSingle(sql, { params });
    return data.rows.map((row) => ({
      schemaName: row.nspname,
      tableName: row.relname,
      columnName: row.attname,
      dataType: row.data_type
    }));
  }

  async listTableColumns(_db: string, table?: string, schema: string = this._defaultSchema): Promise<ExtendedTableColumn[]> {
    // if you provide table, you have to provide schema
    const clause = table ? "WHERE table_schema = $1 AND table_name = $2" : ""
    const params = table ? [schema, table] : []
    if (table && !schema) {
      throw new Error(`Table '${table}' provided for listTableColumns, but no schema name`)
    }

    const sql = `
      SELECT
        table_schema,
        table_name,
        column_name,
        is_nullable,
        ordinal_position,
        column_default,
        CASE
          WHEN character_maximum_length is not null  and udt_name != 'text'
            THEN udt_name || '(' || character_maximum_length::varchar(255) || ')'
          WHEN numeric_precision is not null and numeric_scale is not null
          	THEN udt_name || '(' || numeric_precision::varchar(255) || ',' || numeric_scale::varchar(255) || ')'
          WHEN numeric_precision is not null and numeric_scale is null
            THEN udt_name || '(' || numeric_precision::varchar(255) || ')'
          WHEN datetime_precision is not null AND udt_name != 'date' THEN
            udt_name || '(' || datetime_precision::varchar(255) || ')'
          ELSE udt_name
        END as data_type
      FROM information_schema.columns
      ${clause}
      ORDER BY table_schema, table_name, ordinal_position
    `;

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row: any) => ({
      schemaName: row.table_schema,
      tableName: row.table_name,
      columnName: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      ordinalPosition: Number(row.ordinal_position),
    }));
  }

  async listTableTriggers(table: string, schema: string = this._defaultSchema): Promise<TableTrigger[]> {
    // action_timing has taken over from condition_timing
    // condition_timing was last used in PostgreSQL version 9.0
    // which is not supported anymore since 08 Oct 2015.
    // From version 9.1 onwards, released 08 Sep 2011,
    // action_timing was used instead
    const timing_column = this.version.number <= 90000 ? 'condition_timing' : 'action_timing'
    const sql = `
      SELECT
        trigger_name,
        ${timing_column} as timing,
        event_manipulation as manipulation,
        action_statement as action,
        action_condition as condition
      FROM information_schema.triggers
      WHERE event_object_schema = $1
      AND event_object_table = $2
    `
    const params = [
      schema,
      table,
    ];

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row) => ({
      name: row.trigger_name,
      timing: row.timing,
      manipulation: row.manipulation,
      action: row.action,
      condition: row.condition,
      table: table,
      schema: schema
    }));
  }

  async listTableIndexes(_db: string, table: string, schema: string = this._defaultSchema): Promise<TableIndex[]> {
    const sql = `
    SELECT i.indexrelid::regclass AS indexname,
        k.i AS index_order,
        i.indexrelid as id,
        i.indisunique,
        i.indisprimary,
        coalesce(a.attname,
                  (('{' || pg_get_expr(
                              i.indexprs,
                              i.indrelid
                          )
                        || '}')::text[]
                  )[k.i]
                ) AS index_column,
        i.indoption[k.i - 1] = 0 AS ascending
      FROM pg_index i
        CROSS JOIN LATERAL (SELECT unnest(i.indkey), generate_subscripts(i.indkey, 1) + 1) AS k(attnum, i)
        LEFT JOIN pg_attribute AS a
            ON i.indrelid = a.attrelid AND k.attnum = a.attnum
        JOIN pg_class t on t.oid = i.indrelid
        JOIN pg_namespace c on c.oid = t.relnamespace
      WHERE
      c.nspname = $1 AND
      t.relname = $2

  `
    const params = [
      schema,
      table,
    ];

    const data = await this.driverExecuteSingle(sql, { params });

    const grouped = _.groupBy(data.rows, 'indexname')

    const result = Object.keys(grouped).map((indexName) => {
      const blob = grouped[indexName]
      const unique = blob[0].indisunique
      const id = blob[0].id
      const primary = blob[0].indisprimary
      const columns: IndexedColumn[] = _.sortBy(blob, 'index_order').map((b) => {
        return {
          name: b.index_column,
          order: b.ascending ? 'ASC' : 'DESC'
        }
      })
      const item: TableIndex = {
        table, schema,
        id,
        name: indexName,
        unique,
        primary,
        columns
      }
      return item
    })

    return result
  }

  async listSchemas(_db: string, filter?: SchemaFilterOptions): Promise<string[]> {
    const schemaFilter = buildSchemaFilter(filter);
    const sql = `
      SELECT schema_name
      FROM information_schema.schemata
      ${schemaFilter ? `WHERE ${schemaFilter}` : ''}
      ORDER BY schema_name
    `;

    const data = await this.driverExecuteSingle(sql);

    return data.rows.map((row) => row.schema_name);
  }

  async getTableReferences(table: string, schema: string = this._defaultSchema): Promise<string[]> {
    const sql = `
      SELECT ctu.table_name AS referenced_table_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.constraint_table_usage AS ctu
      ON ctu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
      AND tc.table_schema = $2
    `;

    const params = [
      table,
      schema,
    ];

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row) => row.referenced_table_name);
  }

  async getTableKeys(_db: string, table: string, schema: string = this._defaultSchema): Promise<TableKey[]> {
    const sql = `
      SELECT
        kcu.constraint_schema AS from_schema,
        kcu.table_name AS from_table,
        STRING_AGG(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS from_column,
        rc.unique_constraint_schema AS to_schema,
        tc.constraint_name,
        rc.update_rule,
        rc.delete_rule,
        (
          SELECT STRING_AGG(kcu2.column_name, ',' ORDER BY kcu2.ordinal_position)
          FROM information_schema.key_column_usage AS kcu2
          WHERE kcu2.constraint_name = rc.unique_constraint_name
        ) AS to_column,
        (
          SELECT kcu2.table_name
          FROM information_schema.key_column_usage AS kcu2
          WHERE kcu2.constraint_name = rc.unique_constraint_name LIMIT 1
        ) AS to_table
      FROM
        information_schema.key_column_usage AS kcu
      JOIN
        information_schema.table_constraints AS tc
      ON
        tc.constraint_name = kcu.constraint_name
      JOIN
        information_schema.referential_constraints AS rc
      ON
        rc.constraint_name = kcu.constraint_name
      WHERE
        tc.constraint_type = 'FOREIGN KEY' AND
        kcu.table_schema NOT LIKE 'pg_%' AND
        kcu.table_schema = $2 AND
        kcu.table_name = $1
      GROUP BY
        kcu.constraint_schema,
        kcu.table_name,
        rc.unique_constraint_schema,
        rc.unique_constraint_name,
        tc.constraint_name,
        rc.update_rule,
        rc.delete_rule;
    `;

    const params = [
      table,
      schema,
    ];

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row) => ({
      toTable: row.to_table,
      toSchema: row.to_schema,
      toColumn: row.to_column,
      fromTable: row.from_table,
      fromSchema: row.from_schema,
      fromColumn: row.from_column,
      constraintName: row.constraint_name,
      onUpdate: row.update_rule,
      onDelete: row.delete_rule
    }));
  }

  query(queryText: string): CancelableQuery {
    let pid: any = null;
    let canceling = false;
    const cancelable = createCancelablePromise(errors.CANCELED_BY_USER);

    return {
      execute: (async (): Promise<NgQueryResult[]> => {
        const dataPid = await this.driverExecuteSingle('SELECT pg_backend_pid() AS pid');
        const rows = dataPid.rows

        pid = rows[0].pid;

        try {
          const data = await Promise.race([
            cancelable.wait(),
            this.executeQuery(queryText, {arrayMode: true}),
          ]);

          pid = null;

          if(!data) {
            return []
          }

          return data
        } catch (err) {
          if (canceling && err.code === pgErrors.CANCELED) {
            canceling = false;
            err.sqlectronError = 'CANCELED_BY_USER';
          }

          throw err;
        } finally {
          cancelable.discard();
        }
      }).bind(this),

      cancel: (async (): Promise<void> => {
        if (!pid) {
          throw new Error('Query not ready to be canceled');
        }

        canceling = true;
        try {
          const data = await this.driverExecuteSingle(`SELECT pg_cancel_backend(${pid});`);

          const rows = data.rows

          if (!rows[0].pg_cancel_backend) {
            throw new Error(`Failed canceling query with pid ${pid}.`);
          }

          cancelable.cancel();
        } catch (err) {
          canceling = false;
          throw err;
        }
      }).bind(this),
    };
  }

  async executeQuery(queryText: string, options?: any): Promise<NgQueryResult[]> {
    const arrayMode: boolean = options?.arrayMode;
    const data = await this.driverExecuteMultiple(queryText, { arrayMode });

    const commands = this.identifyCommands(queryText).map((item) => item.type);

    return data.map((result, idx) => this.parseRowQueryResult(result, commands[idx], arrayMode));
  }

  async listDatabases(filter?: DatabaseFilterOptions): Promise<string[]> {
    const databaseFilter = buildDatabaseFilter(filter, 'datname');
    const sql = `
      SELECT datname
      FROM pg_database
      WHERE datistemplate = $1
      ${databaseFilter ? `AND ${databaseFilter}` : ''}
      ORDER BY datname
    `;

    const params = [false];

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row) => row.datname);
  }

  applyChangesSql(changes: TableChanges): string {
    return applyChangesSql(changes, this.knex)
  }

  async applyChanges(changes: TableChanges): Promise<any[]> {
    let results: TableUpdateResult[] = []

    await this.cacheConnection();
    
    await this.driverExecuteSingle('BEGIN')
    log.debug("Applying changes", changes)
    try {
      if (changes.inserts) {
        await this.insertRows(changes.inserts);
      }

      if (changes.updates) {
        results = await this.updateValues(changes.updates)
      }

      if (changes.deletes) {
        await this.deleteRows(changes.deletes)
      }

      await this.driverExecuteSingle('COMMIT')
    } catch (ex) {
      log.error("query exception: ", ex)
      await this.driverExecuteSingle('ROLLBACK');
      throw ex
    }

    this.releaseCachedConnection();
    return results
  }

  getQuerySelectTop(table: string, limit: number, schema: string = this._defaultSchema): string {
    return `SELECT * FROM ${wrapIdentifier(schema)}.${wrapIdentifier(table)} LIMIT ${limit}`;
  }

  async getTableProperties(table: string, schema: string = this._defaultSchema): Promise<TableProperties> {
    const identifier = this.wrapTable(table, schema)

    const statements = [
      `pg_indexes_size('${identifier}') as index_size`,
        `pg_relation_size('${identifier}') as table_size`,
        `obj_description('${identifier}'::regclass) as description`
    ]

    if (this.version.number < 90000) {
      statements[0] = `0 as index_size`
    }

    const sql = `SELECT ${statements.join(",")}`

    const detailsPromise =  this.driverExecuteSingle(sql);

    const triggersPromise = this.listTableTriggers(table, schema);
    const partitionsPromise = this.listTablePartitions(table, schema);

    const [
      result,
      indexes,
      relations,
      triggers,
      partitions,
      owner
    ] = await Promise.all([
      detailsPromise,
      this.listTableIndexes(null, table, schema),
      this.getTableKeys(null, table, schema),
      triggersPromise,
      partitionsPromise,
      this.getTableOwner(table, schema)
    ])

    const props = result.rows.length > 0 ? result.rows[0] : {}
    return {
      description: props.description,
      indexSize: Number(props.index_size),
      size: Number(props.table_size),
      indexes,
      relations,
      triggers,
      partitions,
      owner
    }
  }  

  async getTableCreateScript(table: string, schema: string = this._defaultSchema): Promise<string> {
    // Reference http://stackoverflow.com/a/32885178
    const includesAttIdentify = this.version.number >= 100000;

    const sql = includesAttIdentify ? postgres10CreateScript : defaultCreateScript;
    const params = [
      table,
      schema,
    ];

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row) => row.createtable)[0];
  }

  async getViewCreateScript(view: string, schema: string = this._defaultSchema): Promise<string[]> {
    const createViewSql = `CREATE OR REPLACE VIEW ${wrapIdentifier(schema)}.${wrapIdentifier(view)} AS`;

    const sql = 'SELECT pg_get_viewdef($1::regclass, true)';

    const params = [wrapIdentifier(view)];

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row) => `${createViewSql}\n${row.pg_get_viewdef}`);
  }

  async getRoutineCreateScript(routine: string, _type: string, schema: string = this._defaultSchema): Promise<string[]> {
    const sql = `
      SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE proname = $1
      AND n.nspname = $2
    `;

    const params = [
      routine,
      schema,
    ];

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row) => row.pg_get_functiondef);
  }

  async truncateAllTables(_db: string, schema: string = this._defaultSchema): Promise<void> {
    const sql = `
      SELECT quote_ident(table_name) as table_name
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_type NOT LIKE '%VIEW%'
    `;

    const params = [
      schema,
    ];

    const data = await this.driverExecuteSingle(sql, { params });
    const rows = data.rows

    const truncateAll = rows.map((row) => `
      TRUNCATE TABLE ${wrapIdentifier(schema)}.${wrapIdentifier(row.table_name)}
      RESTART IDENTITY CASCADE;
    `).join('');

    await this.driverExecuteMultiple(truncateAll);
  }  

  async listMaterializedViews(filter?: FilterOptions): Promise<TableOrView[]> {
    if (this.version.number < 90003) {
      return []
    }

    const schemaFilter = buildSchemaFilter(filter, 'schemaname')
    const sql = `
      SELECT
        schemaname as schema,
        matviewname as name
      FROM pg_matviews
      ${schemaFilter ? `WHERE ${schemaFilter}`: ''}
      order by schemaname, matviewname;
    `

    try {
      const data = await this.driverExecuteSingle(sql);
      return data.rows;
    } catch (error) {
      log.warn("Unable to fetch materialized views", error)
      return []
    }
  }

  async getPrimaryKey(db: string, table: string, schema: string = this._defaultSchema): Promise<string> {
    const keys = await this.getPrimaryKeys(db, table, schema)
    return keys.length === 1 ? keys[0].columnName : null
  }

  async getPrimaryKeys(_db: string, table: string, schema: string = this._defaultSchema): Promise<PrimaryKeyColumn[]> {
    const tablename = PD.escapeString(this.tableName(table, schema), true)
    const query = `
      SELECT
        a.attname as column_name,
        format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnum as position
      FROM   pg_index i
      JOIN   pg_attribute a ON a.attrelid = i.indrelid
                          AND a.attnum = ANY(i.indkey)
      WHERE  i.indrelid = ${tablename}::regclass
      AND    i.indisprimary
      ORDER BY a.attnum
    `
    const data = await this.driverExecuteSingle(query)
    if (data.rows) {
      return data.rows.map((r) => ({
        columnName: r.column_name,
        position: r.position
      }))
    } else {
      return []
    }
  }

  async getTableLength(table: string, schema: string = this._defaultSchema): Promise<number> {
    const tableType = await this.getEntityType(table, schema)
    const forceSlow = !tableType || tableType !== 'BASE_TABLE'
    const { countQuery, params } = this.buildSelectTopQueries({ table, schema, filters: undefined, version: this.version, forceSlow})
    const countResults = await this.driverExecuteSingle(countQuery, { params: params })
    const rowWithTotal = countResults.rows.find((row: any) => { return row.total })
    const totalRecords = rowWithTotal ? rowWithTotal.total : 0
    return totalRecords
  }

  async selectTop(table: string, offset: number, limit: number, orderBy: OrderBy[], filters: string | TableFilter[], schema: string = this._defaultSchema, selects?: string[]): Promise<TableResult> {
    const qs = await this._selectTopSql(table, offset, limit, orderBy, filters, schema, selects)
    const result = await this.driverExecuteSingle(qs.query, { params: qs.params })
    return {
      result: result.rows,
      fields: result.fields.map(f => f.name)
    }
  }

  async selectTopSql(table: string, offset: number, limit: number, orderBy: OrderBy[], filters: string | TableFilter[], schema: string = this._defaultSchema, selects?: string[]): Promise<string> {
    const qs = await this._selectTopSql(table, offset, limit, orderBy, filters, schema, selects, true)
    return qs.query
  }

  async selectTopStream(db: string, table: string, orderBy: OrderBy[], filters: string | TableFilter[], chunkSize: number, schema: string = this._defaultSchema): Promise<StreamResults> {
    const qs = this.buildSelectTopQueries({
      table, orderBy, filters, version: this.version, schema
    })
    // const cursor = new Cursor(qs.query, qs.params)
    const countResults = await this.driverExecuteSingle(qs.countQuery, {params: qs.params})
    const rowWithTotal = countResults.rows.find((row: any) => { return row.total })
    const totalRecords = rowWithTotal ? Number(rowWithTotal.total) : 0
    const columns = await this.listTableColumns(db, table, schema)

    const cursorOpts = {
      query: qs.query,
      params: qs.params,
      conn: this.conn,
      chunkSize
    }

    return {
      totalRows: totalRecords,
      columns,
      cursor: new PsqlCursor(cursorOpts)
    }
  }

  async queryStream(_db: string, query: string, chunkSize: number): Promise<StreamResults> {
    const cursorOpts = {
      query: query,
      params: [],
      conn: this.conn,
      chunkSize
    }

    return {
      totalRows: undefined, // totalRecords,
      columns: undefined, // columns,
      cursor: new PsqlCursor(cursorOpts)
    }
  }

  wrapIdentifier(value: string): string {
    if (value === '*') return value;
    const matched = value.match(/(.*?)(\[[0-9]\])/); // eslint-disable-line no-useless-escape
    if (matched) return this.wrapIdentifier(matched[1]) + matched[2];
    return `"${value.replaceAll(/"/g, '""')}"`;
  }

  async setTableDescription(table: string, description: string, schema: string = this._defaultSchema): Promise<string> {
    const identifier = this.wrapTable(table, schema)
    const comment  = escapeString(description)
    const sql = `COMMENT ON TABLE ${identifier} IS '${comment}'`
    await this.driverExecuteSingle(sql)
    const result = await this.getTableProperties(table, schema)
    return result?.description
  }

  async dropElement(elementName: string, typeOfElement: DatabaseElement, schema: string = this._defaultSchema): Promise<void> {
    const sql = `DROP ${PD.wrapLiteral(DatabaseElement[typeOfElement])} ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(elementName)}`

    await this.driverExecuteSingle(sql)
  }

  async truncateElement(elementName: string, typeOfElement: DatabaseElement, schema: string = this._defaultSchema): Promise<void> {
    const sql = `TRUNCATE ${PD.wrapLiteral(typeOfElement)} ${wrapIdentifier(schema)}.${wrapIdentifier(elementName)}`

    await this.driverExecuteSingle(sql)
  }

  async duplicateTable(tableName: string, duplicateTableName: string, schema: string = this._defaultSchema): Promise<void> {
    const sql = this.duplicateTableSql(tableName, duplicateTableName, schema);

    await this.driverExecuteSingle(sql);
  }

  duplicateTableSql(tableName: string, duplicateTableName: string, schema: string = this._defaultSchema): string {
    const sql = `
      CREATE TABLE ${wrapIdentifier(schema)}.${wrapIdentifier(duplicateTableName)} AS
      SELECT * FROM ${wrapIdentifier(schema)}.${wrapIdentifier(tableName)}
    `;

    return sql;
  }

  async listCharsets(): Promise<string[]> {
    return PD.charsets
  }

  async getDefaultCharset(): Promise<string> {
    return 'UTF8'
  }

  async listCollations(_charset: string): Promise<string[]> {
    return []
  }

  async createDatabase(databaseName: string, charset: string, _collation: string): Promise<void> {
    const { number: versionAsInteger } = this.version;

    let sql = `create database ${wrapIdentifier(databaseName)} encoding ${wrapIdentifier(charset)}`;

    // postgres 9 seems to freak out if the charset isn't wrapped in single quotes and also requires the template https://www.postgresql.org/docs/9.3/sql-createdatabase.html
    // later version don't seem to care
    if (versionAsInteger < 100000) {
      sql = `create database ${wrapIdentifier(databaseName)} encoding '${charset}' template template0`;
    }

    await this.driverExecuteSingle(sql)
  }

  createDatabaseSQL(): string {
    throw new Error('Method not implemented.');
  }

  
  alterPartitionSql(payload: AlterPartitionsSpec): string {
    const { table } = payload;
    const builder = new PostgresqlChangeBuilder(table);
    const creates = builder.createPartitions(payload.adds);
    const alters = builder.alterPartitions(payload.alterations);
    const detaches = builder.detachPartitions(payload.detaches);
    return [creates, alters, detaches].filter((f) => !!f).join(";")
  }

  async alterPartition(payload: AlterPartitionsSpec): Promise<void> {
    const query = this.alterPartitionSql(payload)
    await this.driverExecuteSingle(query);
  }


  async getMaterializedViewCreateScript(view: string, schema: string) {
    const createViewSql = `CREATE OR REPLACE MATERIALIZED VIEW ${wrapIdentifier(schema)}.${view} AS`;

    const sql = 'SELECT pg_get_viewdef($1::regclass, true)';

    const params = [view];

    const data = await this.driverExecuteSingle(sql, { params });

    return data.rows.map((row) => `${createViewSql}\n${row.pg_get_viewdef}`);
  }

  protected async rawExecuteQuery(q: string, options: any): Promise<QueryResult | QueryResult[]> {
    let release = true;
    let connection: PoolClient;
    if (this.runWithConnection) {
      release = false;
      connection = this.runWithConnection.connection;
    } else {
      connection = isConnection(this.conn) ? this.conn.connection : await this.conn.pool.connect(); 
    }

    try {
      return await this.runQuery(connection, q, options)
    } finally {
      if (release) {
        connection.release();
      }
    }
  }

  // ************************************************************************************
  // PUBLIC FOR TESTING
  // ************************************************************************************

  parseFields(fields: any[], rowResults: boolean) {
    return fields.map((field, idx) => {
      field.dataType = dataTypes[field.dataTypeID] || 'user-defined'
      field.id = rowResults ? `c${idx}` : field.name
      return field
    })
  }

  parseRowQueryResult(data: QueryResult, command: string, rowResults: boolean): NgQueryResult {
    const fields = this.parseFields(data.fields, rowResults)
    const fieldIds = fields.map(f => f.id)
    const isSelect = data.command === 'SELECT';
    const rowCount = data.rowCount || data.rows?.length || 0
    return {
      command: command || data.command,
      rows: rowResults ? data.rows.map(r => _.zipObject(fieldIds, r)) : data.rows,
      fields: fields,
      rowCount: rowCount,
      affectedRows: !isSelect && !isNaN(data.rowCount) ? data.rowCount : undefined,
    };
  }

  buildSelectTopQueries(options: STQOptions): STQResults {
    const filters = options.filters
    const orderBy = options.orderBy
    const selects = options.selects ?? ['*']
    let orderByString = ""
    let filterString = ""
    let params: (string | string[])[] = []

    if (orderBy && orderBy.length > 0) {
      orderByString = "ORDER BY " + (orderBy.map((item) => {
        if (_.isObject(item)) {
          return `${wrapIdentifier(item.field)} ${item.dir.toUpperCase()}`
        } else {
          return wrapIdentifier(item)
        }
      })).join(",")
    }

    if (_.isString(filters)) {
      filterString = `WHERE ${filters}`
    } else if (filters && filters.length > 0) {
      let paramIdx = 1
      const allFilters = filters.map((item) => {
        if (item.type === 'in' && _.isArray(item.value)) {
          const values = item.value.map((v, idx) => {
            return options.inlineParams
              ? knex.raw('?', [v]).toQuery()
              : `$${paramIdx + idx}`
          })
          paramIdx += values.length
          return `${wrapIdentifier(item.field)} ${item.type.toUpperCase()} (${values.join(',')})`
        }
        const value = options.inlineParams
          ? knex.raw('?', [item.value]).toQuery()
          : `$${paramIdx}`
        paramIdx += 1
        return `${wrapIdentifier(item.field)} ${item.type.toUpperCase()} ${value}`
      })
      filterString = "WHERE " + joinFilters(allFilters, filters)

      params = filters.flatMap((item) => {
        return _.isArray(item.value) ? item.value : [item.value]
      })
    }

    const selectSQL = `SELECT ${selects.join(', ')}`
    const baseSQL = `
      FROM ${wrapIdentifier(options.schema)}.${wrapIdentifier(options.table)}
      ${filterString}
    `

    // if we're not filtering data we want the optimized approximation of row count
    // rather than a legit row count.
    const countQuery = this.countQuery(options, baseSQL);

    const query = `
      ${selectSQL} ${baseSQL}
      ${orderByString}
      ${_.isNumber(options.limit) ? `LIMIT ${options.limit}` : ''}
      ${_.isNumber(options.offset) ? `OFFSET ${options.offset}` : ''}
      `
    return {
      query, countQuery, params
    }
  }
  // ************************************************************************************
  // PROTECTED HELPER FUNCTIONS
  // ************************************************************************************

  protected countQuery(options: STQOptions, baseSQL: string): string {
    // This comes from this PR, it provides approximate counts for PSQL
    // https://github.com/beekeeper-studio/beekeeper-studio/issues/311#issuecomment-788325650
    // however not using the complex query, just the simple one from the psql docs
    // https://wiki.postgresql.org/wiki/Count_estimate
    // however it doesn't work in redshift or cockroach.
    const tuplesQuery = `
      SELECT
        reltuples as total
      FROM
        pg_class
      where
          oid = '${wrapIdentifier(options.schema)}.${wrapIdentifier(options.table)}'::regclass
    `;

    return !options.filters && !options.forceSlow ? tuplesQuery : `SELECT count(*) as total ${baseSQL}`;
  }

  protected tableName(table: string, schema: string = this._defaultSchema): string{
    return schema ? `${PD.wrapIdentifier(schema)}.${PD.wrapIdentifier(table)}` : PD.wrapIdentifier(table);
  }
  
  protected wrapTable(table: string, schema: string = this._defaultSchema) {
    if (!schema) return wrapIdentifier(table);
    return `${wrapIdentifier(schema)}.${wrapIdentifier(table)}`;
  }

  protected async getTableOwner(table: string, schema: string) {
    const sql = `select tableowner from pg_catalog.pg_tables where tablename = $1 and schemaname = $2`
    const result = await this.driverExecuteSingle(sql, { params: [table, schema]});
    return result.rows[0]?.tableowner;
  }

  protected async configDatabase(server: IDbConnectionServer, database: { database: string}) {
    const config: PoolConfig = {
      host: server.config.host,
      port: server.config.port || undefined,
      password: server.config.password || undefined,
      database: database.database,
      max: 5, // max idle connections per time (30 secs)
      connectionTimeoutMillis: globals.psqlTimeout,
      idleTimeoutMillis: globals.psqlIdleTimeout,
    };

    return this.configurePool(config, server, null);
  }

  protected configurePool(config: PoolConfig, server: IDbConnectionServer, tempUser: string) {
    if (tempUser) {
      config.user = tempUser
    } else if (server.config.user) {
      config.user = server.config.user
    } else if (server.config.osUser) {
      config.user = server.config.osUser
    }

    if(server.config.socketPathEnabled) {
      config.host = server.config.socketPath;
      config.port = null;
      return config;
    }

    if (server.sshTunnel) {
      config.host = server.config.localHost;
      config.port = server.config.localPort;
    }

    if (server.config.ssl) {

      config.ssl = { }

      if (server.config.sslCaFile) {
        config.ssl.ca = readFileSync(server.config.sslCaFile);
      }

      if (server.config.sslCertFile) {
        config.ssl.cert = readFileSync(server.config.sslCertFile);
      }

      if (server.config.sslKeyFile) {
        config.ssl.key = readFileSync(server.config.sslKeyFile);
      }
      if (!config.ssl.key && !config.ssl.ca && !config.ssl.cert) {
        // TODO: provide this as an option in settings
        // not per-connection
        // How it works:
        // if false, cert can be self-signed
        // if true, has to be from a public CA
        // Heroku certs are self-signed.
        // if you provide ca/cert/key files, it overrides this
        config.ssl.rejectUnauthorized = false
      } else {
        config.ssl.rejectUnauthorized = server.config.sslRejectUnauthorized
      }
    }
    return config;
  }

  protected async getTypes(): Promise<any> {
    let sql = `
      SELECT      n.nspname as schema, t.typname as typename, t.oid::int4 as typeid
      FROM        pg_type t
      LEFT JOIN   pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE       (t.typrelid = 0 OR (SELECT c.relkind = 'c' FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid))
      AND     n.nspname NOT IN ('pg_catalog', 'information_schema')
    `
    if (this.version.number < 80300) {
      sql += ` AND     t.typname !~ '^_';`;
    } else {
      sql += ` AND     NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid);`;
    }

    const data = await this.driverExecuteSingle(sql);
    const result: any = {}
    data.rows.forEach((row: any) => {
      result[row.typeid] = row.typename
    })
    _.merge(result, _.invert(pg.types.builtins))
    result[1009] = 'array'
    return result
  }

  // ************************************************************************************
  // PRIVATE HELPER FUNCTIONS
  // NOTE (@day): some of this may need to be protected so redshift and cockroach have access to them
  // ************************************************************************************

  private async cacheConnection() {
    this.runWithConnection = {
      connection: await this.conn.pool.connect()
    };
  }

  private async releaseCachedConnection() {
    this.runWithConnection.connection.release();
    this.runWithConnection = null;
  }

  private async runQuery(connection: pg.PoolClient, query: string, options: any): Promise<QueryResult | QueryResult[]> {
    const args = {
      text: query,
      values: options.params,
      multiResult: options.multiple,
      rowMode: options.arrayMode ? 'array' : undefined
    };

    // node-postgres has support for Promise query
    // but that always returns the "fields" property empty
    return new Promise((resolve, reject) => {
      log.info('RUNNING', query, options.params);
      connection.query(args, (err: Error, data: QueryResult | QueryResult[]) => {
        if (err) return reject(err);
        let qr: QueryResult | QueryResult[];
        if (args.multiResult) {
          qr = Array.isArray(data) ? data : [data];
        } else {
          qr = Array.isArray(data) ? data[0] : data;
        }
        resolve(qr);
      });
    });
  }

  private async insertRows(rawInserts: TableInsert[]) {
    const columnsList = await Promise.all(rawInserts.map((insert) => {
      return this.listTableColumns(null, insert.table, insert.schema);
    }));

    const fixedInserts = rawInserts.map((insert, idx) => {
      const result = { ...insert};
      const columns = columnsList[idx];
      result.data = result.data.map((obj) => {
        return _.mapValues(obj, (value, key) => {
          const column = columns.find((c) => c.columnName === key);
          // fix: we used to serialize arrays before this, now we pass them as
          // json arrays properly
          return this.normalizeValue(value, column.dataType);
        })
      })
      return result;
    })

    await this.driverExecuteSingle(buildInsertQueries(this.knex, fixedInserts).join(";"));

    return true;
  }

  private async updateValues(rawUpdates: TableUpdate[]): Promise<TableUpdateResult[]> {
    const updates = rawUpdates.map((update) => {
      const result = { ...update };
      result.value = this.normalizeValue(update.value, update.columnType);
      return result;
    })
    log.info("applying updates", updates);
    let results: TableUpdateResult[] = [];
    await this.driverExecuteSingle(buildUpdateQueries(this.knex, updates).join(";"));
    // NOTE (@day): this could be a weird issue, we shall see
    const data = await this.driverExecuteSingle(buildSelectQueriesFromUpdates(this.knex, updates).join(";"));
    results = [data.rows[0]];

    return results;
  }

  private async deleteRows(deletes: TableDelete[]) {
    await this.driverExecuteSingle(buildDeleteQueries(this.knex, deletes).join(";"));

    return true
  }

  /**
   * Gets the version details for the connection.
   *
   * Example version strings:
   * CockroachDB CCL v1.1.0 (linux amd64, built 2017/10/12 14:50:18, go1.8.3)
   * CockroachDB CCL v20.1.1 (x86_64-unknown-linux-gnu, built 2020/05/19 14:46:06, go1.13.9)
   *
   * PostgreSQL 9.4.26 on x86_64-pc-linux-gnu (Debian 9.4.26-1.pgdg90+1), compiled by gcc (Debian 6.3.0-18+deb9u1) 6.3.0 20170516, 64-bit
   * PostgreSQL 12.3 (Debian 12.3-1.pgdg100+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 8.3.0-6) 8.3.0, 64-bit
   *
   * PostgreSQL 8.0.2 on i686-pc-linux-gnu, compiled by GCC gcc (GCC) 3.4.2 20041017 (Red Hat 3.4.2-6.fc3), Redshift 1.0.12103
   */
  private async getVersion(): Promise<VersionInfo> {
    const { version } = (await this.driverExecuteSingle("select version()")).rows[0]

    if (!version) {
      return {
        version: '',
        number: 0,
        hasPartitions: false
      }
    }

    const isCockroach = version.toLowerCase().includes('cockroachdb')
    const isRedshift = version.toLowerCase().includes('redshift')
    const isPostgres = !isCockroach && !isRedshift
    const number = parseInt(
        version.split(" ")[isPostgres ? 1 : 2].replace(/(^v)|(,$)/ig, '').split(".").map((s: string) => s.padStart(2, "0")).join("").padEnd(6, "0"),
        10
      );
    return {
      version,
      number,
      hasPartitions: (isPostgres && number >= 100000), //for future cochroach support?: || (isCockroach && number >= 200070)
    }
  }
  
  

  private async getEntityType(
    table: string,
    schema: string
  ): Promise<string | null> {
    const query = `
      select table_type as tt from information_schema.tables
      where table_name = $1 and table_schema = $2
      `
    const result = await this.driverExecuteSingle(query, { params: [table, schema]})
    return result.rows[0]? result.rows[0]['tt'] : null
  }

  private async _selectTopSql(
    table: string,
    offset: number,
    limit: number,
    orderBy: OrderBy[],
    filters: TableFilter[] | string,
    schema = "public",
    selects = ["*"],
    inlineParams?: boolean,
  ): Promise<STQResults> {
    return this.buildSelectTopQueries({
      table,
      offset,
      limit,
      orderBy,
      filters,
      selects,
      schema,
      version: this.version,
      inlineParams
    })
  }
  
  

  

  // If a type starts with an underscore - it's an array
  // so we need to turn the string representation back to an array
  // if a type is BYTEA, decodes BASE64 URL encoded to hex
  private normalizeValue(value: string, columnType: string) {
    if (columnType?.startsWith('_') && _.isString(value)) {
      return JSON.parse(value)
    } else if (columnType === 'bytea' && value) {
      return '\\x' + base64.decode(value, 'hex')
    }
    return value
  }
  
  private async getSchema() {
    const sql = 'SELECT CURRENT_SCHEMA() AS schema';

    const data = await this.driverExecuteSingle(sql);
    return data.rows[0].schema;
  }

  private identifyCommands(queryText: string) {
    try {
      return identify(queryText);
    } catch (err) {
      return [];
    }
  }

}


/**
 * Do not convert DATE types to JS date.
 * It ignores of applying a wrong timezone to the date.
 *
 * See also: https://github.com/brianc/node-postgres/issues/285
 * (and note that the code refrenced in /lib/textParsers.js has been broken out into it own module
 * so it now lives in https://github.com/brianc/node-pg-types/blob/master/lib/textParsers.js#L175)
 *
 * TODO: do not convert as well these same types with array (types 1115, 1182, 1185)
 */
pg.types.setTypeParser(pg.types.builtins.DATE,        'text', (val) => val); // date
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP,   'text', (val) => val); // timestamp without timezone
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, 'text', (val) => val); // timestamp
pg.types.setTypeParser(pg.types.builtins.INTERVAL,    'text', (val) => val); // interval (Issue #1442 "BUG: INTERVAL columns receive wrong value when cloning row)

/**
 * Convert BYTEA type encoded to hex with '\x' prefix to BASE64 URL (without '+' and '=').
 */
pg.types.setTypeParser(17, 'text', (val) => val ? base64.encode(val.substring(2), 'hex') : '');

export function wrapIdentifier(value: string): string {
  if (value === '*') return value;
  const matched = value.match(/(.*?)(\[[0-9]\])/); // eslint-disable-line no-useless-escape
  if (matched) return wrapIdentifier(matched[1]) + matched[2];
  return `"${value.replaceAll(/"/g, '""')}"`;
}

export default async function(server: IDbConnectionServer, database: IDbConnectionDatabase) {
  const client = new PostgresClient(server, database);
  await client.connect();
  return client;
}
