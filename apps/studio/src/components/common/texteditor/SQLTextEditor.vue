<template>
  <text-editor
    v-bind="$attrs"
    :value="value"
    @input="$emit('input', $event)"
    :lang="connectionType || 'sql'"
    :extra-keybindings="keybindings"
    :hint-options="hintOptions"
    :columns-getter="columnsGetter"
    :context-menu-options="handleContextMenuOptions"
    :forced-value="forcedValue"
    :plugins="plugins"
    @update:focus="$emit('update:focus', $event)"
    @update:selection="$emit('update:selection', $event)"
    @update:cursorIndex="$emit('update:cursorIndex', $event)"
    @update:initialized="$emit('update:initialized', $event)"
  />
</template>

<script lang="ts">
import Vue from "vue";
import TextEditor from "./TextEditor.vue";
import { mapState } from "vuex";
import { plugins } from "@/lib/editor/utils";
import { format } from "sql-formatter";
import { FormatterDialect, dialectFor } from "@shared/lib/dialects/models";

export default Vue.extend({
  components: { TextEditor },
  props: ["value", "connectionType", "extraKeybindings", "contextMenuOptions"],
  data() {
    return {
      forcedValue: this.value,
    };
  },
  computed: {
    ...mapState(["tables"]),
    hintOptions() {
      const firstTables = {};
      const secondTables = {};
      const thirdTables = {};

      this.tables.forEach((table) => {
        // don't add table names that can get in conflict with database schema
        if (/\./.test(table.name)) return;

        // Previously we had to provide a table: column[] mapping.
        // we don't need to provide the columns anymore because we fetch them dynamically.
        if (!table.schema) {
          firstTables[table.name] = [];
          return;
        }

        if (table.schema === this.defaultSchema) {
          firstTables[table.name] = [];
          secondTables[`${table.schema}.${table.name}`] = [];
        } else {
          thirdTables[`${table.schema}.${table.name}`] = [];
        }
      });

      const sorted = Object.assign(
        firstTables,
        Object.assign(secondTables, thirdTables)
      );

      return { tables: sorted };
    },
    keybindings() {
      return {
        "Shift-Ctrl-F": this.formatSql,
        "Shift-Cmd-F": this.formatSql,
        ...this.extraKeybindings,
      };
    },
    plugins() {
      return [
        plugins.autoquote,
        plugins.autoComplete,
        plugins.autoRemoveQueryQuotes(this.connectionType),
      ];
    },
  },
  methods: {
    async formatSql() {
      const formatted = format(this.value, {
        language: FormatterDialect(dialectFor(this.lang)),
      });
      await this.setEditorValue(formatted);
    },
    async columnsGetter(tableName: string) {
      const tableToFind = this.tables.find(
        (t) => t.name === tableName || `${t.schema}.${t.name}` === tableName
      );
      if (!tableToFind) return null;
      // Only refresh columns if we don't have them cached.
      if (!tableToFind.columns?.length) {
        await this.$store.dispatch("updateTableColumns", tableToFind);
      }

      return tableToFind?.columns.map((c) => c.columnName);
    },
    handleContextMenuOptions(e: unknown, options: any[]) {
      const pivot = options.findIndex((o) => o.slug === "find");
      const newOptions = [
        ...options.slice(0, pivot),
        {
          name: "Format Query",
          slug: "format",
          handler: this.formatSql,
          shortcut: this.ctrlOrCmd("shift+f"),
        },
        {
          type: "divider",
        },
        ...options.slice(pivot + 1),
      ];

      if (this.contextMenuOptions) {
        return this.contextMenuOptions(e, newOptions);
      }

      return newOptions;
    },
    async setEditorValue(value: string) {
      this.forcedValue = this.value;
      await this.$nextTick();
      this.forcedValue = value;
    },
  },
});
</script>
