-- XML Handler for Dynamic Dialplan
-- Generates dialplan on-the-fly for API calling product

-- This is called by FreeSWITCH when looking up dialplan

local params = XML_REQUEST["params"]
local section = params:getHeader("section")
local destination = params:getHeader("Caller-Destination-Number")

if section == "dialplan" then
    -- Return a basic dialplan that routes to Lua
    XML_STRING = [[
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<document type="freeswitch/xml">
  <section name="dialplan" description="Dynamic Dialplan">
    <context name="public">
      <extension name="dynamic">
        <condition field="destination_number" expression=".*">
          <action application="lua" data="inbound_router.lua"/>
        </condition>
      </extension>
    </context>
  </section>
</document>
    ]]
end
