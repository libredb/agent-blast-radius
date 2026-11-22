-- Lets long inline code (image digests, file names, hashes) break across lines in the pdfLaTeX build.
function Code(el)
  if #el.text > 16 and el.text:match('^[%w%./:_%-@=]+$') then
    local t = el.text:gsub('_', '\\_')
    return pandoc.RawInline('latex', '\\texttt{\\seqsplit{' .. t .. '}}')
  end
end

-- Long unbroken words in the appendix (joined identifiers, grant lists) get break points after ; , . : _ =
function Str(el)
  if not (#el.text > 30 or (#el.text > 12 and el.text:find('_'))) then return nil end
  local out = {}
  for part in el.text:gmatch('[^;,%.:_=]*[;,%.:_=]?') do
    if #part > 0 then
      table.insert(out, pandoc.Str(part))
      table.insert(out, pandoc.RawInline('latex', '\\allowbreak{}'))
    end
  end
  return out
end

-- Bare links print as \url (xurl breaks them anywhere); runs after Str above, so its break points are discarded.
function Link(el)
  if el.target:match('^https?://') and
     pandoc.utils.stringify(el.content) == el.target then
    return pandoc.RawInline('latex', '\\url{' .. el.target:gsub('%%', '\\%%'):gsub('#', '\\#') .. '}')
  end
end
