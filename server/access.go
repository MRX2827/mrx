package main

import (
	"slices"
	"strings"
)

func hasMember(doc map[string]interface{}, field, uid string) bool {
	list, _ := doc[field].([]interface{})
	return slices.Contains(list, interface{}(uid))
}

func chatPublic(doc map[string]interface{}) bool {
	kind, _ := doc["type"].(string)
	tag, _ := doc["tag"].(string)
	return tag != "" && (kind == "group" || kind == "channel")
}

func visibleDoc(uid, path string, data map[string]interface{}) map[string]interface{} {
	parts := strings.Split(path, "/")
	if len(parts) == 2 && parts[0] == "chats" {
		if hasMember(data, "members", uid) {
			return data
		}
		if chatPublic(data) {
			out := map[string]interface{}{}
			for _, key := range []string{"id", "type", "name", "desc", "tag", "photo", "creatorUid"} {
				if value, ok := data[key]; ok {
					out[key] = value
				}
			}
			return out
		}
		return nil
	}
	if len(parts) == 2 && parts[0] == "users" && parts[1] != uid {
		out := map[string]interface{}{}
		for _, key := range []string{"id", "uid", "tag", "name", "bio", "photo", "photoURL",
			"bgPhoto", "lastSeen", "appActive", "pinnedTrack", "achievementIds", "equippedIds", "isBot", "bot"} {
			if value, ok := data[key]; ok {
				out[key] = value
			}
		}
		return out
	}
	return data
}

func readableCollection(uid, parent string) bool {
	switch parent {
	case "users", "chats", "stories":
		return true
	}
	parts := strings.Split(parent, "/")
	if len(parts) != 3 {
		return false
	}
	switch {
	case parts[0] == "users" && parts[2] == "contacts":
		return parts[1] == uid
	case parts[0] == "chats" && parts[2] == "messages":
		chat, _ := loadDocData("chats/" + parts[1])
		return hasMember(chat, "members", uid)
	case parts[0] == "stories" && (parts[2] == "likes" || parts[2] == "views"):
		story, _ := loadDocData("stories/" + parts[1])
		return story["uid"] == uid
	}
	return false
}

func readableDocument(uid, path string) bool {
	parent, id, ok := splitDocPath(path)
	if !ok {
		return false
	}
	if parent == "diag" {
		return id == "d_"+uid
	}
	parts := strings.Split(parent, "/")
	if len(parts) == 3 && parts[0] == "stories" && (parts[2] == "likes" || parts[2] == "views") {
		return id == uid || readableCollection(uid, parent)
	}
	return readableCollection(uid, parent)
}

func fieldsOnly(patch map[string]interface{}, keys ...string) bool {
	for key := range patch {
		if !slices.Contains(keys, key) {
			return false
		}
	}
	return true
}

func sameMembers(proposed, original interface{}) bool {
	a, ok := proposed.([]interface{})
	if !ok {
		return false
	}
	b, _ := original.([]interface{})
	if len(a) != len(b) {
		return false
	}
	for _, value := range a {
		member, ok := value.(string)
		if !ok || !slices.Contains(b, interface{}(member)) {
			return false
		}
	}
	return true
}

func allowedWrite(uid, path, method string, patch map[string]interface{}) bool {
	parent, id, ok := splitDocPath(path)
	if !ok {
		return false
	}
	old, exists := loadDocData(path)
	switch parent {
	case "users":
		return id == uid
	case "diag":
		return id == "d_"+uid
	case "chats":
		if !exists {
			if !hasMember(patch, "members", uid) || method == "DELETE" {
				return false
			}
			if patch["type"] == "direct" {
				others, _ := patch["members"].([]interface{})
				if len(others) != 2 {
					return false
				}
				a, aOK := others[0].(string)
				b, bOK := others[1].(string)
				pair := []string{a, b}
				slices.Sort(pair)
				return aOK && bOK && a != b && id == strings.Join(pair, "_")
			}
			return patch["creatorUid"] == uid
		}
		if old["creatorUid"] == uid {
			return method == "DELETE" || (patch["creatorUid"] == nil || patch["creatorUid"] == uid)
		}
		if !hasMember(old, "members", uid) {
			memberPatch, ok := patch["members"].(map[string]interface{})
			items, _ := memberPatch["__arrayUnion__"].([]interface{})
			return chatPublic(old) && method == "PATCH" && fieldsOnly(patch, "members") &&
				ok && len(items) == 1 && items[0] == uid
		}
		if method != "PATCH" && method != "MERGE" {
			return false
		}
		if members, present := patch["members"]; present && !sameMembers(members, old["members"]) {
			// A member can leave. Owners control other membership changes.
			next, _ := members.([]interface{})
			previous, _ := old["members"].([]interface{})
			remaining := slices.DeleteFunc(slices.Clone(previous), func(v interface{}) bool { return v == uid })
			if !sameMembers(next, remaining) {
				return false
			}
		}
		for key := range patch {
			if key == "members" || slices.Contains([]string{"lastMsg", "lastTime", "lastTimeMs", "lastSender", "updatedAt"}, key) ||
				strings.HasPrefix(key, "unreadBy.") || key == "typing."+uid || key == "hiddenFor."+uid ||
				key == "photos."+uid || key == "names."+uid {
				continue
			}
			if old["type"] == "direct" && slices.Contains([]string{"id", "type", "names", "photos", "created"}, key) {
				continue
			}
			return false
		}
		return true
	case "stories":
		if !exists {
			return patch["uid"] == uid && method != "DELETE"
		}
		return old["uid"] == uid || (method == "PATCH" && fieldsOnly(patch, "viewCount", "likeCount"))
	}
	parts := strings.Split(parent, "/")
	if len(parts) != 3 {
		return false
	}
	switch {
	case parts[0] == "users" && parts[2] == "contacts":
		return parts[1] == uid
	case parts[0] == "stories" && (parts[2] == "likes" || parts[2] == "views"):
		_, storyExists := loadDocData("stories/" + parts[1])
		return storyExists && id == uid
	case parts[0] == "chats" && parts[2] == "messages":
		chat, _ := loadDocData("chats/" + parts[1])
		if !hasMember(chat, "members", uid) {
			return false
		}
		if !exists {
			return method != "DELETE" && patch["uid"] == uid &&
				(chat["type"] != "channel" || chat["creatorUid"] == uid)
		}
		if method == "DELETE" {
			return old["uid"] == uid || chat["creatorUid"] == uid
		}
		if method == "PATCH" && fieldsOnly(patch, "readBy", "deletedFor", "reactions."+uid) {
			for _, field := range []string{"readBy", "deletedFor"} {
				if value, present := patch[field]; present {
					transform, _ := value.(map[string]interface{})
					items, _ := transform["__arrayUnion__"].([]interface{})
					if len(items) != 1 || items[0] != uid {
						return false
					}
				}
			}
			return true
		}
		return old["uid"] == uid && method == "PATCH" && fieldsOnly(patch, "text", "edited")
	}
	return false
}
