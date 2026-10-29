{{#each files}}
<system-reminder reason="directory-rules" path="{{path}}">
{{#if omitted}}
Context file for {{dir}} not attached: this tool batch's context-file budget is spent. MUST read {{path}} before changing files in that directory.
{{else}}
Context file for {{dir}}, attached because a tool reached that directory. MUST follow it for files there; it overrides rules from higher directories.

{{content}}
{{#if truncated}}

[Truncated: showing the first {{shownChars}} of {{totalChars}} characters. Read {{path}} for the rest.]
{{/if}}
{{/if}}
</system-reminder>
{{/each}}
